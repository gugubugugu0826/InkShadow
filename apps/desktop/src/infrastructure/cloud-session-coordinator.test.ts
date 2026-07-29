import { CloudClientError } from "@inkshadow/cloud-client";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "@inkshadow/domain";

import {
  CloudSessionCoordinator,
  type CloudSessionCoordinatorError,
  type CloudIdentitySessionPort,
} from "./cloud-session-coordinator";
import type { CloudSessionVaultStatus } from "./cloud-session-vault";

const SESSION_ID = "018f0d7a-3b2c-7abc-8def-000000000111";
const NEXT_SESSION_ID = "018f0d7a-3b2c-7abc-8def-000000000112";
const NOW = "2026-07-27T00:00:00.000Z";

describe("CloudSessionCoordinator", () => {
  it("uses a sufficiently fresh native session without rotating it", async () => {
    const fixture = createFixture(status({ accessExpiresAt: "2026-07-27T00:10:00.000Z" }));

    const result = await fixture.coordinator.ensureReady();

    expect(result.session.sessionId).toBe(SESSION_ID);
    expect(fixture.identity.refresh).not.toHaveBeenCalled();
  });

  it("serializes concurrent refreshes before the access credential expires", async () => {
    let release!: (value: CloudSessionVaultStatus) => void;
    const pending = new Promise<CloudSessionVaultStatus>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture(status({ accessExpiresAt: "2026-07-27T00:00:30.000Z" }), pending);

    const first = fixture.coordinator.ensureReady();
    const second = fixture.coordinator.ensureReady();
    release(status({ sessionId: NEXT_SESSION_ID, accessExpiresAt: "2026-07-27T01:00:00.000Z" }));

    const [left, right] = await Promise.all([first, second]);
    expect(left.session.sessionId).toBe(NEXT_SESSION_ID);
    expect(right.session.sessionId).toBe(NEXT_SESSION_ID);
    expect(fixture.identity.refresh).toHaveBeenCalledTimes(1);
    expect(fixture.identity.refresh).toHaveBeenCalledWith(SESSION_ID);
  });

  it("refreshes and retries once when the server reports an expired access session", async () => {
    const fixture = createFixture(status({ accessExpiresAt: "2026-07-27T00:10:00.000Z" }));
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(cloudError("AUTH_SESSION_EXPIRED"))
      .mockResolvedValueOnce("ok");

    await expect(fixture.coordinator.runWithSession(operation)).resolves.toBe("ok");
    expect(fixture.identity.refresh).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("retries with a session that another caller already rotated", async () => {
    const fixture = createFixture(status({ accessExpiresAt: "2026-07-27T00:10:00.000Z" }));
    fixture.identity.getStatus
      .mockResolvedValueOnce(status({ accessExpiresAt: "2026-07-27T00:10:00.000Z" }))
      .mockResolvedValueOnce(
        status({
          sessionId: NEXT_SESSION_ID,
          accessExpiresAt: "2026-07-27T01:00:00.000Z",
        }),
      );
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(cloudError("AUTH_SESSION_EXPIRED"))
      .mockResolvedValueOnce("ok");

    await expect(fixture.coordinator.runWithSession(operation)).resolves.toBe("ok");
    expect(fixture.identity.refresh).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("clears an expired refresh grant and requires authentication", async () => {
    const fixture = createFixture(
      status({
        accessExpiresAt: "2026-07-26T23:00:00.000Z",
        refreshExpiresAt: "2026-07-27T00:00:00.000Z",
      }),
    );

    await expect(fixture.coordinator.ensureReady()).rejects.toMatchObject({
      reason: "reauth_required",
      sourceCode: "AUTH_REFRESH_EXPIRED",
    });
    expect(fixture.identity.clearLocalSession).toHaveBeenCalledWith(SESSION_ID);
    expect(fixture.identity.refresh).not.toHaveBeenCalled();
  });

  it("clears terminally revoked device sessions and exposes a stable block reason", async () => {
    const fixture = createFixture(
      status({ accessExpiresAt: "2026-07-27T00:00:30.000Z" }),
      Promise.reject(cloudError("AUTH_DEVICE_REVOKED")),
    );

    await expect(fixture.coordinator.ensureReady()).rejects.toEqual(
      expect.objectContaining<Partial<CloudSessionCoordinatorError>>({
        reason: "device_revoked",
        sourceCode: "AUTH_DEVICE_REVOKED",
      }),
    );
    expect(fixture.identity.clearLocalSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("fails closed when terminal-session clearing cannot be persisted", async () => {
    const fixture = createFixture(
      status({ accessExpiresAt: "2026-07-27T00:00:30.000Z" }),
      Promise.reject(cloudError("AUTH_SESSION_REVOKED")),
    );
    fixture.identity.clearLocalSession.mockRejectedValueOnce(new Error("credential store denied"));

    await expect(fixture.coordinator.ensureReady()).rejects.toMatchObject({
      reason: "reauth_required",
    });
    expect(fixture.identity.disableAfterReconciliationFailure).toHaveBeenCalledTimes(1);
  });

  it("does no native work when already aborted", async () => {
    const fixture = createFixture(status());
    const controller = new AbortController();
    controller.abort();

    await expect(
      fixture.coordinator.ensureReady({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.identity.getStatus).not.toHaveBeenCalled();
  });
});

function createFixture(
  initial: CloudSessionVaultStatus,
  refreshResult?: Promise<CloudSessionVaultStatus>,
) {
  const identity = {
    available: true,
    getStatus: vi.fn(() => Promise.resolve(initial)),
    refresh: vi.fn(
      () =>
        refreshResult ??
        Promise.resolve(
          status({
            sessionId: NEXT_SESSION_ID,
            accessExpiresAt: "2026-07-27T01:00:00.000Z",
          }),
        ),
    ),
    clearLocalSession: vi.fn(() => Promise.resolve(emptyStatus())),
    disableAfterReconciliationFailure: vi.fn(),
  } satisfies CloudIdentitySessionPort;
  const clock: Clock = { now: () => NOW as ReturnType<Clock["now"]> };
  return {
    coordinator: new CloudSessionCoordinator(identity, clock),
    identity,
  };
}

function status(
  overrides: {
    readonly accessExpiresAt?: string;
    readonly refreshExpiresAt?: string;
    readonly sessionId?: string;
  } = {},
): CloudSessionVaultStatus {
  const sessionId = overrides.sessionId ?? SESSION_ID;
  const accessExpiresAt = overrides.accessExpiresAt ?? "2026-07-27T00:10:00.000Z";
  const refreshExpiresAt = overrides.refreshExpiresAt ?? "2026-08-27T00:00:00.000Z";
  return {
    configured: true,
    account: {
      schemaVersion: 1,
      accountId: "018f0d7a-3b2c-7abc-8def-000000000101",
      state: "active",
      revision: 1,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      verifiedAt: "2026-07-26T00:00:00.000Z",
      deletionScheduledFor: null,
    },
    device: {
      schemaVersion: 1,
      displayName: "此设备",
      revision: 1,
      device: {
        schemaVersion: 1,
        deviceId: "018f0d7a-3b2c-7abc-8def-000000000102",
        accountId: "018f0d7a-3b2c-7abc-8def-000000000101",
        publicKeyFingerprint: "a".repeat(64),
        state: "trusted",
        createdAt: "2026-07-26T00:00:00.000Z",
        revokedAt: null,
      },
      publicKey: {
        schemaVersion: 1,
        deviceId: "018f0d7a-3b2c-7abc-8def-000000000102",
        accountId: "018f0d7a-3b2c-7abc-8def-000000000101",
        algorithm: "DHKEM-P256-HKDF-SHA256",
        publicKey: "A".repeat(87),
        publicKeyFingerprint: "a".repeat(64),
        createdAt: "2026-07-26T00:00:00.000Z",
        revokedAt: null,
      },
    },
    session: {
      schemaVersion: 1,
      sessionId,
      accountId: "018f0d7a-3b2c-7abc-8def-000000000101",
      deviceId: "018f0d7a-3b2c-7abc-8def-000000000102",
      clientVersion: "0.1.0",
      minimumClientVersion: "0.1.0",
      issuedAt: "2026-07-26T00:00:00.000Z",
      expiresAt: accessExpiresAt,
      revokedAt: null,
    },
    expiry: {
      accessExpiresAt,
      refreshExpiresAt,
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

function cloudError(code: ConstructorParameters<typeof CloudClientError>[0]["code"]) {
  return new CloudClientError({
    code,
    message: code,
    status: 401,
    requestId: null,
    retryable: false,
  });
}
