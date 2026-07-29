import { describe, expect, it } from "vitest";

import {
  CloudAccount,
  CloudSession,
  isAuthenticationLocked,
  recordAuthenticationFailure,
  resetAuthenticationThrottle,
  type RegisteredDevice,
} from "../src/index.js";

const T0 = "2026-07-27T00:00:00.000Z";
const T1 = "2026-07-27T00:01:00.000Z";
const DELETE_AT = "2026-08-27T00:00:00.000Z";
const DEVICE: RegisteredDevice = {
  deviceId: "device-1",
  accountId: "account-1",
  state: "trusted",
  publicKeyFingerprint: "sha256-device-key",
};

describe("cloud account lifecycle", () => {
  it("requires verification before a cloud session and supports lock/freeze transitions", () => {
    const pending = CloudAccount.register("account-1", T0);
    expect(pending.canCreateCloudSession()).toBe(false);

    const active = pending.verify(T1);
    expect(active.canCreateCloudSession()).toBe(true);
    expect(active.lock("2026-07-27T00:02:00.000Z").canCreateCloudSession()).toBe(false);
    expect(
      active
        .freeze("2026-07-27T00:02:00.000Z")
        .unfreeze("2026-07-27T00:03:00.000Z")
        .canCreateCloudSession(),
    ).toBe(true);
  });

  it("separates scheduled deletion, cancellation, and irreversible finalization time", () => {
    const active = CloudAccount.register("account-1", T0).verify(T1);
    const scheduled = active.scheduleDeletion(DELETE_AT, "2026-07-27T00:02:00.000Z");

    expect(() => scheduled.finalizeDeletion("2026-08-26T23:59:59.999Z")).toThrow();
    expect(scheduled.cancelDeletion("2026-07-28T00:00:00.000Z").canCreateCloudSession()).toBe(true);
    expect(scheduled.finalizeDeletion(DELETE_AT).toSnapshot().state).toBe("deleted");
  });
});

describe("cloud sessions", () => {
  it("binds a session to an active account, trusted device, expiry, and minimum client version", () => {
    const account = CloudAccount.register("account-1", T0).verify(T1);
    const session = CloudSession.create(
      {
        sessionId: "session-1",
        accountId: "account-1",
        deviceId: "device-1",
        clientVersion: "1.4.0",
        minimumClientVersion: "1.3.0",
        issuedAt: "2026-07-27T00:02:00.000Z",
        expiresAt: "2026-07-28T00:02:00.000Z",
      },
      account,
      DEVICE,
    );

    expect(session.evaluate("2026-07-27T12:00:00.000Z", account, DEVICE)).toBe("active");
    expect(session.evaluate("2026-07-28T00:02:00.000Z", account, DEVICE)).toBe("expired");
    expect(
      session.evaluate("2026-07-27T12:00:00.000Z", account, {
        ...DEVICE,
        state: "revoked",
      }),
    ).toBe("device_revoked");
    expect(
      session.evaluate(
        "2026-07-27T12:00:00.000Z",
        account.lock("2026-07-27T10:00:00.000Z"),
        DEVICE,
      ),
    ).toBe("account_blocked");
  });

  it("requires an upgrade and makes session revocation idempotent", () => {
    const account = CloudAccount.register("account-1", T0).verify(T1);
    const session = CloudSession.create(
      {
        sessionId: "session-1",
        accountId: "account-1",
        deviceId: "device-1",
        clientVersion: "1.2.9",
        minimumClientVersion: "1.3.0",
        issuedAt: "2026-07-27T00:02:00.000Z",
        expiresAt: "2026-07-28T00:02:00.000Z",
      },
      account,
      DEVICE,
    );

    expect(session.evaluate("2026-07-27T12:00:00.000Z", account, DEVICE)).toBe("upgrade_required");
    const revoked = session.revoke("2026-07-27T12:00:00.000Z");
    expect(revoked.evaluate("2026-07-27T12:01:00.000Z", account, DEVICE)).toBe("revoked");
    expect(revoked.revoke("2026-07-27T12:02:00.000Z")).toBe(revoked);
  });
});

describe("authentication throttling", () => {
  it("locks after a bounded failure window without retaining passwords or email values", () => {
    const policy = { maximumFailures: 3, windowMs: 60_000, lockMs: 120_000 };
    let state = resetAuthenticationThrottle();
    state = recordAuthenticationFailure(state, policy, T0);
    state = recordAuthenticationFailure(state, policy, "2026-07-27T00:00:10.000Z");
    state = recordAuthenticationFailure(state, policy, "2026-07-27T00:00:20.000Z");

    expect(isAuthenticationLocked(state, "2026-07-27T00:01:00.000Z")).toBe(true);
    expect(isAuthenticationLocked(state, "2026-07-27T00:02:20.000Z")).toBe(false);
    expect(state).not.toHaveProperty("password");
    expect(state).not.toHaveProperty("email");
  });

  it("resets the failure count after the attempt window", () => {
    const policy = { maximumFailures: 3, windowMs: 60_000, lockMs: 120_000 };
    const first = recordAuthenticationFailure(resetAuthenticationThrottle(), policy, T0);
    const resetWindow = recordAuthenticationFailure(first, policy, "2026-07-27T00:01:00.000Z");

    expect(resetWindow.failureCount).toBe(1);
    expect(resetWindow.windowStartedAt).toBe("2026-07-27T00:01:00.000Z");
  });
});
