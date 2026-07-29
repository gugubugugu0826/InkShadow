import { beforeAll, describe, expect, it } from "vitest";

import {
  OfflineLicenseVerifier,
  canonicalizeOfflineLicensePayload,
  encodeBase64Url,
  type OfflineLicensePayload,
  type SignedOfflineLicense,
} from "../src/index.js";

const PAYLOAD: OfflineLicensePayload = {
  schemaVersion: 1,
  licenseId: "license-1",
  product: "inkshadow",
  keyId: "release-key-1",
  deviceId: "device-1",
  tier: "pro",
  issuedAt: "2026-07-01T00:00:00.000Z",
  notBefore: "2026-07-01T00:00:00.000Z",
  validUntil: "2026-08-01T00:00:00.000Z",
  graceUntil: "2026-08-08T00:00:00.000Z",
  capabilities: ["ai.advanced", "sync.e2ee"],
  featureFlags: ["ai.advanced", "sync.e2ee"],
};

let keyPair: CryptoKeyPair;

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
});

async function sign(payload: OfflineLicensePayload = PAYLOAD): Promise<SignedOfflineLicense> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    keyPair.privateKey,
    new TextEncoder().encode(canonicalizeOfflineLicensePayload(payload)),
  );
  return { payload, signature: encodeBase64Url(new Uint8Array(signature)) };
}

function verifier() {
  return new OfflineLicenseVerifier(new Map([[PAYLOAD.keyId, keyPair.publicKey]]));
}

describe("signed offline licenses", () => {
  it("verifies Ed25519 evidence and derives active, grace, and offline-expired states", async () => {
    const envelope = await sign();

    await expect(
      verifier().verify({
        envelope,
        expectedDeviceId: PAYLOAD.deviceId,
        now: "2026-07-27T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      evidence: "offline_license_verified",
      subscriptionState: "active",
    });
    await expect(
      verifier().verify({
        envelope,
        expectedDeviceId: PAYLOAD.deviceId,
        now: "2026-08-05T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ subscriptionState: "grace" });
    await expect(
      verifier().verify({
        envelope,
        expectedDeviceId: PAYLOAD.deviceId,
        now: "2026-08-09T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ subscriptionState: "offline_expired" });
  });

  it("rejects payload tampering even when the shape remains valid", async () => {
    const envelope = await sign();
    const tampered = {
      ...envelope,
      payload: { ...envelope.payload, tier: "enterprise" },
    };

    await expect(
      verifier().verify({
        envelope: tampered,
        expectedDeviceId: PAYLOAD.deviceId,
        now: "2026-07-27T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_LICENSE_SIGNATURE_INVALID" });
  });

  it("rejects device mismatch, unknown key, and not-yet-valid evidence", async () => {
    const envelope = await sign();
    await expect(
      verifier().verify({
        envelope,
        expectedDeviceId: "device-2",
        now: "2026-07-27T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_LICENSE_DEVICE_MISMATCH" });
    await expect(
      new OfflineLicenseVerifier(new Map()).verify({
        envelope,
        expectedDeviceId: PAYLOAD.deviceId,
        now: "2026-07-27T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_LICENSE_KEY_UNKNOWN" });
    await expect(
      verifier().verify({
        envelope,
        expectedDeviceId: PAYLOAD.deviceId,
        now: "2026-06-30T23:59:59.999Z",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_LICENSE_NOT_YET_VALID" });
  });

  it("rejects extra fields, duplicate capabilities, and invalid chronological windows", async () => {
    const envelope = await sign();
    await expect(
      verifier().verify({
        envelope: { ...envelope, unexpected: true },
        expectedDeviceId: PAYLOAD.deviceId,
        now: "2026-07-27T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_LICENSE_FORMAT_INVALID" });
    await expect(
      sign({ ...PAYLOAD, capabilities: ["sync.e2ee", "sync.e2ee"] }),
    ).rejects.toMatchObject({ code: "ACCESS_VALIDATION_FAILED" });
    await expect(
      sign({ ...PAYLOAD, graceUntil: "2026-07-15T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "ACCESS_LICENSE_FORMAT_INVALID" });
  });
});
