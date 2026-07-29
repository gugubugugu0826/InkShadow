import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

import {
  BrowserDevelopmentCloudSessionVault,
  TauriCloudSessionVault,
  type CloudSessionVaultStatus,
} from "./cloud-session-vault";

const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000101";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000102";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000103";

describe("cloud session vault adapters", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
  });

  it("uses dedicated native commands and never returns session tokens", async () => {
    const status = configuredStatus();
    tauriMocks.invoke.mockResolvedValueOnce(status).mockResolvedValueOnce(status);

    const vault = new TauriCloudSessionVault({
      baseUrl: "https://cloud.example.test",
    });
    const login = await vault.login({
      email: "writer@example.test",
      password: "test-secure-password",
      deviceId: DEVICE_ID,
      displayName: "Writer",
    });
    await vault.refresh(SESSION_ID);

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "login_cloud_identity", {
      input: {
        endpoint: {
          baseUrl: "https://cloud.example.test",
          allowInsecureLoopback: false,
        },
        email: "writer@example.test",
        password: "test-secure-password",
        device: {
          deviceId: DEVICE_ID,
          displayName: "Writer",
        },
      },
    });
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "refresh_cloud_session", {
      input: { expectedSessionId: SESSION_ID },
    });
    expect(JSON.stringify(login)).not.toMatch(/accessToken|refreshToken/u);
  });

  it("rejects partial or identity-inconsistent native status payloads", async () => {
    tauriMocks.invoke.mockResolvedValueOnce({
      ...configuredStatus(),
      session: null,
    });
    const vault = new TauriCloudSessionVault({
      baseUrl: "https://cloud.example.test",
    });

    await expect(vault.getStatus()).rejects.toThrow(
      "Cloud session status must be either fully configured or fully empty.",
    );
  });

  it.each([
    {
      name: "inactive account",
      mutate: (status: CloudSessionVaultStatus) => ({
        ...status,
        account: { ...requireAccount(status), state: "locked" as const },
      }),
    },
    {
      name: "revoked device",
      mutate: (status: CloudSessionVaultStatus) => ({
        ...status,
        device: {
          ...requireDevice(status),
          device: {
            ...requireDevice(status).device,
            state: "revoked" as const,
            revokedAt: "2026-07-27T00:30:00.000Z",
          },
          publicKey: {
            ...requireDevice(status).publicKey,
            revokedAt: "2026-07-27T00:30:00.000Z",
          },
        },
      }),
    },
    {
      name: "device creation mismatch",
      mutate: (status: CloudSessionVaultStatus) => ({
        ...status,
        device: {
          ...requireDevice(status),
          publicKey: {
            ...requireDevice(status).publicKey,
            createdAt: "2026-07-27T00:00:00.001Z",
          },
        },
      }),
    },
    {
      name: "unsupported client version",
      mutate: (status: CloudSessionVaultStatus) => ({
        ...status,
        session: {
          ...requireSession(status),
          clientVersion: "0.1.0",
          minimumClientVersion: "0.2.0",
        },
      }),
    },
  ])("rejects $name from the native status boundary", async ({ mutate }) => {
    tauriMocks.invoke.mockResolvedValueOnce(mutate(configuredStatus()));
    const vault = new TauriCloudSessionVault({
      baseUrl: "https://cloud.example.test",
    });

    await expect(vault.getStatus()).rejects.toThrow(
      "Cloud session status identities or expiry metadata do not agree.",
    );
  });

  it("exposes only conditional clearing for an empty browser-development vault", async () => {
    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    const vault = new BrowserDevelopmentCloudSessionVault();

    expect(vault.available).toBe(false);
    await expect(vault.getStatus()).resolves.toEqual({
      configured: false,
      account: null,
      device: null,
      session: null,
      expiry: null,
    });
    await expect(vault.clear(SESSION_ID)).resolves.toMatchObject({ configured: false });
    await expect(
      vault.login({
        email: "writer@example.test",
        password: "test-secure-password",
        deviceId: DEVICE_ID,
        displayName: "Writer",
      }),
    ).rejects.toThrow("native desktop credential boundary");
    expect(storageSet).not.toHaveBeenCalled();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    storageSet.mockRestore();
  });
});

function requireAccount(
  status: CloudSessionVaultStatus,
): NonNullable<CloudSessionVaultStatus["account"]> {
  if (status.account === null) {
    throw new Error("Test fixture is missing an account.");
  }
  return status.account;
}

function requireDevice(
  status: CloudSessionVaultStatus,
): NonNullable<CloudSessionVaultStatus["device"]> {
  if (status.device === null) {
    throw new Error("Test fixture is missing a device.");
  }
  return status.device;
}

function requireSession(
  status: CloudSessionVaultStatus,
): NonNullable<CloudSessionVaultStatus["session"]> {
  if (status.session === null) {
    throw new Error("Test fixture is missing a session.");
  }
  return status.session;
}

function configuredStatus(): CloudSessionVaultStatus {
  const createdAt = "2026-07-27T00:00:00.000Z";
  const accessExpiresAt = "2026-07-27T01:00:00.000Z";
  const publicKeyFingerprint = "a".repeat(64);
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
        publicKeyFingerprint,
        createdAt,
        revokedAt: null,
      },
      publicKey: {
        schemaVersion: 1,
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        algorithm: "DHKEM-P256-HKDF-SHA256",
        publicKey: "A".repeat(87),
        publicKeyFingerprint,
        createdAt,
        revokedAt: null,
      },
      displayName: "Writer",
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
  };
}
