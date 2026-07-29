import { createECDH, createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";

import type {
  CloudEnterpriseOidcBindingRecord,
  CloudEnterpriseOidcFlowRecord,
} from "../src/domain/enterprise-records.js";
import type { EnterpriseConfiguration } from "../src/enterprise/configuration.js";
import type { EnterpriseOidcClient, VerifiedOidcIdentity } from "../src/enterprise/oidc-client.js";
import type { CloudEnterpriseTransaction } from "../src/repository/enterprise-store.js";
import type { CloudIdentityService } from "../src/service/identity-service.js";
import { CloudEnterpriseOidcService } from "../src/service/enterprise-oidc-service.js";

const TENANT_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const ACCOUNT_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const SESSION_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const FLOW_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const CLAIM_ID = "018f0d7a-3b2c-7abc-8def-000000000008";
const EVENT_ID = "018f0d7a-3b2c-7abc-8def-000000000009";
const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-00000000000a";
const NOW = new Date("2026-07-28T00:00:00.000Z");

describe("Enterprise OIDC service", () => {
  it("binds, consumes and idempotently replays one verified OIDC flow", async () => {
    const device = deviceFixture();
    const transaction = new OidcTransaction(device.fingerprint);
    const identityIssue = vi.fn(() =>
      Promise.resolve(sessionGrant(device.publicKey, device.fingerprint)),
    );
    const oidcExchange = vi.fn(() =>
      Promise.resolve<VerifiedOidcIdentity>({
        issuer: "https://idp.example.test/",
        subject: "provider-subject-1",
        emailCanonical: "writer@example.com",
      }),
    );
    const identifiers = [FLOW_ID, CLAIM_ID, EVENT_ID];
    const service = new CloudEnterpriseOidcService({
      clock: () => NOW,
      configuration: configuration(),
      identityService: {
        issueEnterpriseOidcSession: identityIssue,
      } as unknown as CloudIdentityService,
      oidcClient: {
        discover: vi.fn(() =>
          Promise.resolve({
            issuer: "https://idp.example.test/",
            authorizationEndpoint: "https://idp.example.test/oauth/authorize",
            tokenEndpoint: "https://idp.example.test/oauth/token",
            jwksUri: "https://idp.example.test/.well-known/jwks.json",
          }),
        ),
        exchangeAndVerify: oidcExchange,
      } as unknown as EnterpriseOidcClient,
      store: {
        transaction: (operation) => operation(transaction),
      },
      uuid: () => identifiers.shift() ?? EVENT_ID,
    });

    const authorization = await service.authorize(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        teamId: TEAM_ID,
        redirectUri: "inkshadow://enterprise/sso/callback",
        device: {
          deviceId: DEVICE_ID,
          displayName: "Private workstation",
          algorithm: "DHKEM-P256-HKDF-SHA256",
          publicKey: device.publicKey,
          publicKeyFingerprint: device.fingerprint,
          clientVersion: "0.1.0",
        },
      },
      {
        idempotencyKey: "enterprise-sso-authorize-0001",
        requestId: REQUEST_ID,
      },
    );
    const state = new URL(authorization.authorizationUrl).searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(new URL(authorization.authorizationUrl).searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(transaction.flow).toMatchObject({
      flowId: FLOW_ID,
      policyRevision: 4,
      attemptCount: 0,
    });
    if (state === null) {
      throw new Error("Authorization fixture did not contain state.");
    }
    const callback = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      flowId: FLOW_ID,
      flowSecret: authorization.flowSecret,
      state,
      code: "one-time-authorization-code",
      redirectUri: "inkshadow://enterprise/sso/callback",
      device: {
        deviceId: DEVICE_ID,
        displayName: "Private workstation",
        algorithm: "DHKEM-P256-HKDF-SHA256" as const,
        publicKey: device.publicKey,
        publicKeyFingerprint: device.fingerprint,
        clientVersion: "0.1.0",
      },
    };

    await expect(
      service.complete(
        {
          ...callback,
          state: `${state.slice(0, -1)}${state.endsWith("x") ? "y" : "x"}`,
        },
        {
          idempotencyKey: "enterprise-sso-complete-0001",
          requestId: REQUEST_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "SSO_STATE_INVALID" });
    expect(oidcExchange).not.toHaveBeenCalled();

    const first = await service.complete(callback, {
      idempotencyKey: "enterprise-sso-complete-0001",
      requestId: REQUEST_ID,
    });
    expect(first).toMatchObject({
      enterprise: {
        authenticationMethod: "oidc",
        policyRevision: 4,
        teamId: TEAM_ID,
      },
      session: { sessionId: SESSION_ID },
    });
    expect(transaction.flow).toMatchObject({
      consumedAt: NOW,
      verifiedAccountId: ACCOUNT_ID,
      completionIdempotencyKeyHashSha256: createHash("sha256")
        .update("enterprise-sso-complete-0001", "utf8")
        .digest("hex"),
    });
    expect(transaction.binding).toMatchObject({
      accountId: ACCOUNT_ID,
      membershipId: MEMBERSHIP_ID,
    });
    expect(oidcExchange).toHaveBeenCalledOnce();

    await expect(
      service.complete(callback, {
        idempotencyKey: "enterprise-sso-complete-0001",
        requestId: REQUEST_ID,
      }),
    ).resolves.toMatchObject({ session: { sessionId: SESSION_ID } });
    expect(oidcExchange).toHaveBeenCalledOnce();
    expect(identityIssue).toHaveBeenCalledTimes(2);

    await expect(
      service.complete(callback, {
        idempotencyKey: "enterprise-sso-complete-different",
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "SSO_FLOW_REPLAYED" });
  });
});

class OidcTransaction implements CloudEnterpriseTransaction {
  public flow: CloudEnterpriseOidcFlowRecord | null = null;
  public binding: CloudEnterpriseOidcBindingRecord | null = null;

  public constructor(private readonly approvedFingerprint: string) {}

  public setPrincipal(): Promise<void> {
    return Promise.resolve();
  }

  public clearTeamScope(): Promise<void> {
    return Promise.resolve();
  }

  public setTeamScope(): Promise<void> {
    return Promise.resolve();
  }

  public assertPrincipalActive(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public findActiveMembershipForAccount() {
    return Promise.resolve(null);
  }

  public findTeam() {
    return Promise.resolve(null);
  }

  public findMembership() {
    return Promise.resolve(null);
  }

  public countTrustedDevices(): Promise<number> {
    return Promise.resolve(1);
  }

  public findTrustedDevice() {
    return Promise.resolve(null);
  }

  public lockIdempotency(): Promise<void> {
    return Promise.resolve();
  }

  public findIdempotency() {
    return Promise.resolve(null);
  }

  public insertIdempotency(): Promise<void> {
    return Promise.resolve();
  }

  public findPolicy() {
    return Promise.resolve(null);
  }

  public insertPolicy(): Promise<void> {
    return Promise.resolve();
  }

  public updatePolicyCas(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public findPublicSsoPolicy() {
    return Promise.resolve({
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      revision: 4,
      ssoMode: "required" as const,
      allowedEmailDomains: ["example.com"],
      sessionMaximumMinutes: 240,
      maximumTrustedDevices: 2,
      deviceApprovalMode: "approved_fingerprint" as const,
      approvedDeviceFingerprints: [this.approvedFingerprint],
    });
  }

  public findRequiredSsoTeams() {
    return Promise.resolve([]);
  }

  public insertOidcFlow(record: CloudEnterpriseOidcFlowRecord): Promise<void> {
    this.flow = record;
    return Promise.resolve();
  }

  public resolveOidcFlowScope() {
    return Promise.resolve(this.flow === null ? null : { tenantId: TENANT_ID, teamId: TEAM_ID });
  }

  public findOidcFlow() {
    return Promise.resolve(this.flow);
  }

  public updateOidcFlow(record: CloudEnterpriseOidcFlowRecord): Promise<void> {
    this.flow = record;
    return Promise.resolve();
  }

  public resolveMember() {
    return Promise.resolve({
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      accountId: ACCOUNT_ID,
      membershipId: MEMBERSHIP_ID,
      role: "owner" as const,
    });
  }

  public findOidcBinding() {
    return Promise.resolve(this.binding);
  }

  public findOidcBindingForAccount() {
    return Promise.resolve(this.binding);
  }

  public insertOidcBinding(record: CloudEnterpriseOidcBindingRecord): Promise<void> {
    this.binding = record;
    return Promise.resolve();
  }

  public updateOidcBinding(record: CloudEnterpriseOidcBindingRecord): Promise<void> {
    this.binding = record;
    return Promise.resolve();
  }

  public insertAuditEvent(): Promise<void> {
    return Promise.resolve();
  }
}

function configuration(): EnterpriseConfiguration {
  return {
    deploymentId: "customer-primary",
    flowKey: Buffer.alloc(32, 0x71),
    flowLifetimeMs: 600_000,
    metadataCacheMs: 300_000,
    providers: new Map([
      [
        TEAM_ID,
        {
          teamId: TEAM_ID,
          issuer: "https://idp.example.test/",
          clientId: "inkshadow-private",
          clientSecret: "s".repeat(32),
          redirectUris: ["inkshadow://enterprise/sso/callback"],
        },
      ],
    ]),
    license: {
      schemaVersion: 1,
      product: "inkshadow",
      licenseId: "license-primary",
      keyId: "enterprise-2026",
      deploymentId: "customer-primary",
      tier: "enterprise",
      issuedAt: "2026-01-01T00:00:00.000Z",
      notBefore: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
      capabilities: ["enterprise.policy", "enterprise.private_deployment", "enterprise.sso"],
      licensedTeamIds: [TEAM_ID],
      fingerprintSha256: "f".repeat(64),
    },
  };
}

function deviceFixture(): { readonly publicKey: string; readonly fingerprint: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey(undefined, "uncompressed");
  return {
    publicKey: publicKey.toString("base64url"),
    fingerprint: createHash("sha256").update(publicKey).digest("hex"),
  };
}

function sessionGrant(publicKey: string, fingerprint: string) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    account: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      accountId: ACCOUNT_ID,
      state: "active" as const,
      revision: 2,
      verifiedAt: NOW.toISOString(),
      deletionScheduledFor: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
    device: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      device: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        state: "trusted" as const,
        publicKeyFingerprint: fingerprint,
        createdAt: NOW.toISOString(),
        revokedAt: null,
      },
      publicKey: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        algorithm: "DHKEM-P256-HKDF-SHA256" as const,
        publicKey,
        publicKeyFingerprint: fingerprint,
        createdAt: NOW.toISOString(),
        revokedAt: null,
      },
      displayName: "Private workstation",
      revision: 1,
    },
    session: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      clientVersion: "0.1.0",
      minimumClientVersion: "0.1.0",
      issuedAt: NOW.toISOString(),
      expiresAt: "2026-07-28T01:00:00.000Z",
      revokedAt: null,
    },
    tokens: {
      accessToken: "a".repeat(64),
      accessTokenExpiresAt: "2026-07-28T01:00:00.000Z",
      refreshToken: "b".repeat(64),
      refreshTokenExpiresAt: "2026-08-28T00:00:00.000Z",
    },
  };
}
