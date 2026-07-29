import { describe, expect, it } from "vitest";

import {
  CLOUD_API_OPERATIONS,
  CloudEnterprisePolicyEvaluationRequestSchema,
  CloudEnterprisePolicyUpdateRequestSchema,
  CloudEnterpriseSsoAuthorizationRequestSchema,
  CONTRACT_SCHEMA_VERSION,
  INKSHADOW_CLOUD_OPENAPI,
} from "../src/index.js";

const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const FINGERPRINT = "a1".repeat(32);

describe("Enterprise API contracts", () => {
  it("publishes strict policy, SSO and idempotency operations", () => {
    expect(
      CLOUD_API_OPERATIONS.filter((operation) =>
        operation.operationId.startsWith("enterprise"),
      ).map((operation) => ({
        id: operation.operationId,
        idempotent: operation.requiresIdempotencyKey,
        authenticated: operation.requiresAuthentication,
      })),
    ).toEqual([
      {
        id: "enterprisePolicies.get",
        idempotent: false,
        authenticated: true,
      },
      {
        id: "enterprisePolicies.update",
        idempotent: true,
        authenticated: true,
      },
      {
        id: "enterprisePolicies.evaluate",
        idempotent: true,
        authenticated: true,
      },
      {
        id: "enterpriseSso.getStatus",
        idempotent: false,
        authenticated: true,
      },
      {
        id: "enterpriseSso.authorize",
        idempotent: true,
        authenticated: false,
      },
      {
        id: "enterpriseSso.complete",
        idempotent: true,
        authenticated: false,
      },
    ]);
    expect(JSON.stringify(INKSHADOW_CLOUD_OPENAPI)).not.toMatch(
      /clientSecret|flowKey|licenseJson|privateKey/u,
    );
  });

  it("rejects internally inconsistent organization policy combinations", () => {
    const base = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      expectedRevision: null,
      ssoMode: "required",
      allowedEmailDomains: ["example.com"],
      sessionMaximumMinutes: 480,
      maximumTrustedDevices: 3,
      deviceApprovalMode: "trusted_device",
      approvedDeviceFingerprints: [],
      exportMode: "owners_and_admins",
      externalEgressMode: "blocked",
      allowedExternalHosts: [],
      supportBundleMode: "owners_and_admins",
    } as const;
    expect(CloudEnterprisePolicyUpdateRequestSchema.safeParse(base).success).toBe(true);
    expect(
      CloudEnterprisePolicyUpdateRequestSchema.safeParse({
        ...base,
        deviceApprovalMode: "approved_fingerprint",
      }).success,
    ).toBe(false);
    expect(
      CloudEnterprisePolicyUpdateRequestSchema.safeParse({
        ...base,
        externalEgressMode: "allowlisted",
      }).success,
    ).toBe(false);
    expect(
      CloudEnterprisePolicyUpdateRequestSchema.safeParse({
        ...base,
        allowedEmailDomains: ["z.example.com", "a.example.com"],
      }).success,
    ).toBe(false);
  });

  it("binds SSO authorization to an exact team, redirect and device", () => {
    expect(
      CloudEnterpriseSsoAuthorizationRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        teamId: TEAM_ID,
        redirectUri: "inkshadow://enterprise/sso/callback",
        device: {
          deviceId: DEVICE_ID,
          displayName: "Private workstation",
          algorithm: "DHKEM-P256-HKDF-SHA256",
          publicKey: "A".repeat(87),
          publicKeyFingerprint: FINGERPRINT,
          clientVersion: "0.1.0",
        },
      }).success,
    ).toBe(true);
    expect(
      CloudEnterpriseSsoAuthorizationRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        teamId: TEAM_ID,
        redirectUri: "https://user:password@example.com/callback",
        device: {
          deviceId: DEVICE_ID,
          displayName: "Private workstation",
          algorithm: "DHKEM-P256-HKDF-SHA256",
          publicKey: "A".repeat(87),
          publicKeyFingerprint: FINGERPRINT,
          clientVersion: "0.1.0",
        },
      }).success,
    ).toBe(false);
  });

  it("requires an external host only for external-egress evaluation", () => {
    expect(
      CloudEnterprisePolicyEvaluationRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        action: "external_egress",
        externalHost: "models.example.com",
      }).success,
    ).toBe(true);
    expect(
      CloudEnterprisePolicyEvaluationRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        action: "export",
        externalHost: "models.example.com",
      }).success,
    ).toBe(false);
  });
});
