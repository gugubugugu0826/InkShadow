import { readFileSync } from "node:fs";

import {
  CONTRACT_SCHEMA_VERSION,
  type CloudAccountContract,
  type CloudSessionContract,
  type RegisteredDeviceContract,
  type SignedOfflineLicenseContract,
  type TeamMembershipContract,
} from "@inkshadow/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccessSqliteStore } from "../src/access-sqlite-store.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0003_sync_access.sql", import.meta.url), "utf8"),
].join("\n");

const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000101";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000102";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000103";
const LICENSE_ID = "019f9f4a-b3c7-7350-9226-000000000104";
const MEMBERSHIP_ID = "019f9f4a-b3c7-7350-9226-000000000105";
const TENANT_ID = "019f9f4a-b3c7-7350-9226-000000000106";
const TEAM_ID = "019f9f4a-b3c7-7350-9226-000000000107";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000108";
const SECOND_ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000109";
const SECOND_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000110";
const NEXT_SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000111";
const THIRD_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000112";
const NOW = "2026-07-27T00:00:00.000Z";

describe("AccessSqliteStore", () => {
  let executor: NodeSqliteExecutor;
  let store: AccessSqliteStore;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    store = new AccessSqliteStore(executor);
    expect(await store.saveAccount(accountSnapshot())).toEqual({
      ok: true,
      value: undefined,
    });
  });

  afterEach(async () => {
    await executor.close();
  });

  it("persists strict account, device, and credential-free session metadata", async () => {
    const device = deviceSnapshot();
    const session = sessionSnapshot();

    expect(await store.saveDevice(device)).toEqual({ ok: true, value: undefined });
    expect(await store.saveSessionMetadata(session)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await store.findAccount(ACCOUNT_ID)).toEqual({
      ok: true,
      value: accountSnapshot(),
    });
    expect(await store.findDevice(DEVICE_ID)).toEqual({ ok: true, value: device });
    expect(await store.findSessionMetadata(SESSION_ID)).toEqual({
      ok: true,
      value: session,
    });
    expect(await store.health()).toMatchObject({
      ok: true,
      value: {
        accountsByState: { active: 1 },
        devicesByState: { trusted: 1, revoked: 0 },
        sessionMetadataCount: 1,
        revokedSessionMetadataCount: 0,
        entitlementHintCount: 0,
        offlineLicenseEnvelopeCount: 0,
        membershipsByState: { active: 0, revoked: 0 },
      },
    });

    const unknownFieldInput = {
      ...session,
      unexpectedField: "not-allowed",
    } as CloudSessionContract;
    expect(await store.saveSessionMetadata(unknownFieldInput)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("commits a session grant atomically and rolls back earlier snapshots on conflict", async () => {
    const device = deviceSnapshot();
    const session = sessionSnapshot();
    expect(
      await store.saveSessionGrantMetadata({
        account: accountSnapshot(),
        device,
        session,
      }),
    ).toEqual({ ok: true, value: undefined });

    const secondAccount: CloudAccountContract = {
      ...accountSnapshot(),
      accountId: SECOND_ACCOUNT_ID,
    };
    const secondDevice: RegisteredDeviceContract = {
      ...device,
      accountId: SECOND_ACCOUNT_ID,
      deviceId: SECOND_DEVICE_ID,
    };
    const conflictingSession: CloudSessionContract = {
      ...session,
      accountId: SECOND_ACCOUNT_ID,
      deviceId: SECOND_DEVICE_ID,
    };
    expect(
      await store.saveSessionGrantMetadata({
        account: secondAccount,
        device: secondDevice,
        session: conflictingSession,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(await store.findAccount(SECOND_ACCOUNT_ID)).toEqual({ ok: true, value: null });
    expect(await store.findDevice(SECOND_DEVICE_ID)).toEqual({ ok: true, value: null });
  });

  it("atomically saves the current grant and retires other local sessions for its device", async () => {
    const first = sessionSnapshot();
    expect(
      await store.saveCurrentSessionGrantMetadata({
        account: accountSnapshot(),
        device: deviceSnapshot(),
        session: first,
        supersededAt: "2026-07-27T00:30:00.000Z",
      }),
    ).toEqual({ ok: true, value: undefined });

    const current: CloudSessionContract = {
      ...first,
      sessionId: NEXT_SESSION_ID,
      issuedAt: "2026-07-27T01:00:00.000Z",
      expiresAt: "2026-07-28T01:00:00.000Z",
    };
    expect(
      await store.saveCurrentSessionGrantMetadata({
        account: accountSnapshot(),
        device: deviceSnapshot(),
        session: current,
        supersededAt: "2026-07-27T01:00:00.000Z",
      }),
    ).toEqual({ ok: true, value: undefined });

    expect(await store.findSessionMetadata(SESSION_ID)).toMatchObject({
      ok: true,
      value: { revokedAt: "2026-07-27T01:00:00.000Z" },
    });
    expect(await store.findSessionMetadata(NEXT_SESSION_ID)).toEqual({
      ok: true,
      value: current,
    });
  });

  it("atomically reconciles bounded account devices and sessions", async () => {
    const secondDevice: RegisteredDeviceContract = {
      ...deviceSnapshot(),
      deviceId: SECOND_DEVICE_ID,
      publicKeyFingerprint: "b".repeat(64),
    };
    const secondSession: CloudSessionContract = {
      ...sessionSnapshot(),
      sessionId: NEXT_SESSION_ID,
      deviceId: SECOND_DEVICE_ID,
    };

    expect(
      await store.saveAccountManagementMetadata({
        accountId: ACCOUNT_ID,
        devices: [deviceSnapshot(), secondDevice],
        sessions: [sessionSnapshot(), secondSession],
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(await store.findDevice(SECOND_DEVICE_ID)).toEqual({
      ok: true,
      value: secondDevice,
    });
    expect(await store.findSessionMetadata(NEXT_SESSION_ID)).toEqual({
      ok: true,
      value: secondSession,
    });

    const thirdDevice: RegisteredDeviceContract = {
      ...deviceSnapshot(),
      deviceId: THIRD_DEVICE_ID,
      publicKeyFingerprint: "c".repeat(64),
    };
    expect(
      await store.saveAccountManagementMetadata({
        accountId: ACCOUNT_ID,
        devices: [thirdDevice],
        sessions: [{ ...sessionSnapshot(), deviceId: THIRD_DEVICE_ID }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(await store.findDevice(THIRD_DEVICE_ID)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("rolls back superseded-session retirement when the current grant conflicts", async () => {
    const first = sessionSnapshot();
    expect(
      await store.saveCurrentSessionGrantMetadata({
        account: accountSnapshot(),
        device: deviceSnapshot(),
        session: first,
        supersededAt: "2026-07-27T00:30:00.000Z",
      }),
    ).toEqual({ ok: true, value: undefined });

    const existingCurrent: CloudSessionContract = {
      ...first,
      sessionId: NEXT_SESSION_ID,
      issuedAt: "2026-07-27T01:00:00.000Z",
      expiresAt: "2026-07-28T01:00:00.000Z",
    };
    expect(await store.saveSessionMetadata(existingCurrent)).toEqual({
      ok: true,
      value: undefined,
    });

    expect(
      await store.saveCurrentSessionGrantMetadata({
        account: accountSnapshot(),
        device: deviceSnapshot(),
        session: {
          ...existingCurrent,
          expiresAt: "2026-07-29T01:00:00.000Z",
        },
        supersededAt: "2026-07-27T02:00:00.000Z",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(await store.findSessionMetadata(SESSION_ID)).toEqual({
      ok: true,
      value: first,
    });
  });

  it("allows a pending account to become verified without rewriting its creation metadata", async () => {
    const pending: CloudAccountContract = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      accountId: SECOND_ACCOUNT_ID,
      state: "pending_verification",
      revision: 1,
      verifiedAt: null,
      deletionScheduledFor: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const verified: CloudAccountContract = {
      ...pending,
      state: "active",
      revision: 2,
      verifiedAt: "2026-07-27T00:05:00.000Z",
      updatedAt: "2026-07-27T00:05:00.000Z",
    };

    expect(await store.saveAccount(pending)).toEqual({ ok: true, value: undefined });
    expect(await store.saveAccount(verified)).toEqual({ ok: true, value: undefined });
    expect(await store.findAccount(SECOND_ACCOUNT_ID)).toEqual({
      ok: true,
      value: verified,
    });
  });

  it("prevents revoked device and session identifiers from becoming active again", async () => {
    const device = deviceSnapshot();
    await store.saveDevice(device);
    await store.saveSessionMetadata(sessionSnapshot());

    const revokedAt = "2026-07-27T01:00:00.000Z";
    expect(await store.saveDevice({ ...device, state: "revoked", revokedAt })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await store.saveSessionMetadata({ ...sessionSnapshot(), revokedAt })).toEqual({
      ok: true,
      value: undefined,
    });

    expect(await store.saveDevice(device)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    expect(await store.saveSessionMetadata(sessionSnapshot())).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
  });

  it("reconciles all locally unusable sessions for one device without touching other devices", async () => {
    await store.saveDevice(deviceSnapshot());
    await store.saveSessionMetadata(sessionSnapshot());

    expect(
      await store.revokeDeviceSessionMetadata({
        deviceId: DEVICE_ID,
        revokedAt: "2026-07-27T03:00:00.000Z",
      }),
    ).toEqual({ ok: true, value: 1 });
    expect(await store.findSessionMetadata(SESSION_ID)).toMatchObject({
      ok: true,
      value: { revokedAt: "2026-07-27T03:00:00.000Z" },
    });
    expect(
      await store.revokeDeviceSessionMetadata({
        deviceId: DEVICE_ID,
        revokedAt: "2026-07-27T04:00:00.000Z",
      }),
    ).toEqual({ ok: true, value: 0 });
  });

  it("reloads entitlement cache only as unverified hints that cannot unlock remote features", async () => {
    await store.saveEntitlementHint({
      accountId: ACCOUNT_ID,
      tier: "pro",
      subscriptionState: "active",
      grantedCapabilities: ["sync.e2ee", "local.edit"],
      enabledFlags: ["sync.e2ee"],
      observedAt: NOW,
    });

    const cached = await store.findEntitlementHint(ACCOUNT_ID);

    expect(cached).toMatchObject({
      ok: true,
      value: {
        authoritative: false,
        evaluation: {
          tier: "pro",
          subscriptionState: "active",
          decisions: {
            "local.edit": { allowed: true, reason: "local_always_available" },
            "sync.e2ee": { allowed: false, reason: "evidence_unverified" },
          },
        },
      },
    });
    if (cached.ok && cached.value !== null) {
      expect(cached.value.evaluation.can("local.edit")).toBe(true);
      expect(cached.value.evaluation.can("sync.e2ee")).toBe(false);
    }
    expect(await store.health()).toMatchObject({
      ok: true,
      value: { entitlementHintCount: 1 },
    });
  });

  it("stores signed offline licenses as device-bound envelopes that require re-verification", async () => {
    await store.saveDevice(deviceSnapshot());
    const envelope = licenseEnvelope();

    expect(
      await store.saveOfflineLicenseEnvelope({
        accountId: ACCOUNT_ID,
        envelope,
        savedAt: NOW,
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(await store.findOfflineLicenseEnvelope(LICENSE_ID)).toMatchObject({
      ok: true,
      value: {
        requiresCryptographicVerification: true,
        accountId: ACCOUNT_ID,
        envelope,
      },
    });

    await executor.execute(
      "UPDATE offline_license_envelopes SET envelope_json = ? WHERE license_id = ?",
      [
        JSON.stringify({
          ...envelope,
          unexpectedField: "not-allowed",
        }),
        LICENSE_ID,
      ],
    );
    expect(await store.findOfflineLicenseEnvelope(LICENSE_ID)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("marks team membership snapshots non-authoritative and preserves revocation monotonicity", async () => {
    const membership = membershipSnapshot();
    expect(await store.saveTeamMembership(membership)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await store.findTeamMembership(MEMBERSHIP_ID)).toEqual({
      ok: true,
      value: { authoritative: false, membership },
    });

    const revoked = {
      ...membership,
      state: "revoked",
      revokedAt: "2026-07-27T02:00:00.000Z",
    } as const;
    expect(await store.saveTeamMembership(revoked)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await store.saveTeamMembership(membership)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
  });
});

function accountSnapshot(): CloudAccountContract {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    accountId: ACCOUNT_ID,
    state: "active",
    revision: 2,
    verifiedAt: NOW,
    deletionScheduledFor: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function deviceSnapshot(): RegisteredDeviceContract {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    deviceId: DEVICE_ID,
    accountId: ACCOUNT_ID,
    state: "trusted",
    publicKeyFingerprint: "a".repeat(64),
    createdAt: NOW,
    revokedAt: null,
  };
}

function sessionSnapshot(): CloudSessionContract {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    clientVersion: "1.2.0",
    minimumClientVersion: "1.1.0",
    issuedAt: NOW,
    expiresAt: "2026-07-28T00:00:00.000Z",
    revokedAt: null,
  };
}

function licenseEnvelope(): SignedOfflineLicenseContract {
  return {
    payload: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      licenseId: LICENSE_ID,
      product: "inkshadow",
      keyId: "release-key-1",
      deviceId: DEVICE_ID,
      tier: "pro",
      issuedAt: NOW,
      notBefore: NOW,
      validUntil: "2026-08-27T00:00:00.000Z",
      graceUntil: "2026-09-03T00:00:00.000Z",
      capabilities: ["sync.e2ee"],
      featureFlags: ["sync.e2ee"],
    },
    signature: "AA",
  };
}

function membershipSnapshot(): TeamMembershipContract {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    membershipId: MEMBERSHIP_ID,
    accountId: ACCOUNT_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    role: "reviewer",
    state: "active",
    projectIds: [PROJECT_ID],
    createdAt: NOW,
    revokedAt: null,
  };
}
