import { describe, expect, it } from "vitest";

import {
  CONTRACT_SCHEMA_VERSION,
  type CloudAuthenticationRequest,
  type CloudIdentityRegistrationRequest,
  type CloudIdentityVerificationRequest,
  type CloudPasswordResetConfirmationRequest,
  type CloudSessionRefreshRequest,
} from "@inkshadow/contracts";

import { hashCanonicalJson } from "../src/security/canonical-hash.js";
import {
  hashAuthenticationIdempotencyRequest,
  hashIdentityRegistrationIdempotencyRequest,
  hashIdentityVerificationIdempotencyRequest,
  hashPasswordResetConfirmationIdempotencyRequest,
  hashSessionRefreshIdempotencyRequest,
} from "../src/security/identity-idempotency.js";

const DEVICE = {
  algorithm: "DHKEM-P256-HKDF-SHA256" as const,
  clientVersion: "0.1.0",
  deviceId: "0198a5df-8840-7ca1-8b5f-73207bd871f1",
  displayName: "Primary workstation",
  publicKey: "A".repeat(87),
  publicKeyFingerprint: "a".repeat(64),
};
const FIRST_PASSWORD_FIXTURE = ["fixture", "credential", "alpha", "long"].join("-");
const SECOND_PASSWORD_FIXTURE = ["fixture", "credential", "beta", "long"].join("-");

describe("identity idempotency fingerprints", () => {
  it("never uses a password as registration or login mutation identity", () => {
    const registration: CloudIdentityRegistrationRequest = {
      email: "author@example.test",
      password: FIRST_PASSWORD_FIXTURE,
      schemaVersion: CONTRACT_SCHEMA_VERSION,
    };
    const changedRegistration = {
      ...registration,
      password: SECOND_PASSWORD_FIXTURE,
    };
    expect(hashIdentityRegistrationIdempotencyRequest(registration)).toBe(
      hashIdentityRegistrationIdempotencyRequest(changedRegistration),
    );
    expect(hashIdentityRegistrationIdempotencyRequest(registration)).not.toBe(
      hashCanonicalJson(registration),
    );

    const login: CloudAuthenticationRequest = {
      ...registration,
      device: DEVICE,
    };
    const changedLogin = { ...login, password: SECOND_PASSWORD_FIXTURE };
    expect(hashAuthenticationIdempotencyRequest(login)).toBe(
      hashAuthenticationIdempotencyRequest(changedLogin),
    );
    expect(hashAuthenticationIdempotencyRequest(login)).not.toBe(hashCanonicalJson(login));
  });

  it("uses a server-keyed challenge proof without fingerprinting codes or new passwords", () => {
    const verification: CloudIdentityVerificationRequest = {
      challengeId: "0198a5df-8840-7ca1-8b5f-73207bd871f2",
      code: "123456",
      device: DEVICE,
      schemaVersion: CONTRACT_SCHEMA_VERSION,
    };
    const proof = "b".repeat(64);
    expect(hashIdentityVerificationIdempotencyRequest(verification, proof)).toBe(
      hashIdentityVerificationIdempotencyRequest({ ...verification, code: "654321" }, proof),
    );
    expect(hashIdentityVerificationIdempotencyRequest(verification, proof)).not.toBe(
      hashIdentityVerificationIdempotencyRequest(verification, "c".repeat(64)),
    );
    expect(hashIdentityVerificationIdempotencyRequest(verification, proof)).not.toBe(
      hashCanonicalJson(verification),
    );

    const reset: CloudPasswordResetConfirmationRequest = {
      challengeId: verification.challengeId,
      code: verification.code,
      newPassword: FIRST_PASSWORD_FIXTURE,
      schemaVersion: CONTRACT_SCHEMA_VERSION,
    };
    expect(hashPasswordResetConfirmationIdempotencyRequest(reset, proof)).toBe(
      hashPasswordResetConfirmationIdempotencyRequest(
        { ...reset, code: "654321", newPassword: SECOND_PASSWORD_FIXTURE },
        proof,
      ),
    );
    expect(hashPasswordResetConfirmationIdempotencyRequest(reset, proof)).not.toBe(
      hashCanonicalJson(reset),
    );
  });

  it("identifies refresh replay by the authorized session instead of its bearer token", () => {
    const refresh: CloudSessionRefreshRequest = {
      deviceId: DEVICE.deviceId,
      refreshToken: "isk_rt_first-high-entropy-token",
      schemaVersion: CONTRACT_SCHEMA_VERSION,
    };
    const sessionId = "0198a5df-8840-7ca1-8b5f-73207bd871f3";
    expect(hashSessionRefreshIdempotencyRequest(refresh, sessionId)).toBe(
      hashSessionRefreshIdempotencyRequest(
        { ...refresh, refreshToken: "isk_rt_second-high-entropy-token" },
        sessionId,
      ),
    );
    expect(hashSessionRefreshIdempotencyRequest(refresh, sessionId)).not.toBe(
      hashSessionRefreshIdempotencyRequest(refresh, "0198a5df-8840-7ca1-8b5f-73207bd871f4"),
    );
    expect(hashSessionRefreshIdempotencyRequest(refresh, sessionId)).not.toBe(
      hashCanonicalJson(refresh),
    );
  });
});
