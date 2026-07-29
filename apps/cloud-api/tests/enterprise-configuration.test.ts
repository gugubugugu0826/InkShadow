import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadCloudApiConfiguration } from "../src/config.js";
import { loadEnterpriseConfiguration } from "../src/enterprise/configuration.js";

const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const NOW = new Date("2026-07-28T00:00:00.000Z");

describe("Enterprise configuration", () => {
  it("verifies a deployment-bound offline license and resolves OIDC secrets indirectly", () => {
    const license = signedLicense();
    const result = loadEnterpriseConfiguration(
      {
        INKSHADOW_DEPLOYMENT_MODE: "private",
        INKSHADOW_ENTERPRISE_DEPLOYMENT_ID: "customer-primary",
        INKSHADOW_ENTERPRISE_LICENSE_JSON: license.serialized,
        INKSHADOW_ENTERPRISE_LICENSE_PUBLIC_KEY: license.publicKey,
        INKSHADOW_ENTERPRISE_OIDC_FLOW_KEY: Buffer.alloc(32, 0x71).toString("base64url"),
        INKSHADOW_ENTERPRISE_OIDC_PROVIDERS_JSON: JSON.stringify([
          {
            teamId: TEAM_ID,
            issuer: "https://idp.example.test/",
            clientId: "inkshadow-private",
            clientSecretEnvironment: "INKSHADOW_OIDC_CLIENT_SECRET_PRIMARY",
            redirectUris: ["inkshadow://enterprise/sso/callback"],
          },
        ]),
        INKSHADOW_OIDC_CLIENT_SECRET_PRIMARY: "c".repeat(32),
      },
      () => NOW,
    );

    expect(result.deploymentMode).toBe("private");
    expect(result.enterprise.license).toMatchObject({
      deploymentId: "customer-primary",
      licensedTeamIds: [TEAM_ID],
    });
    expect(result.enterprise.providers.get(TEAM_ID)).toMatchObject({
      clientId: "inkshadow-private",
      clientSecret: "c".repeat(32),
    });
    expect(JSON.stringify(result.enterprise.providers)).not.toContain(
      "INKSHADOW_OIDC_CLIENT_SECRET_PRIMARY",
    );
  });

  it("fails closed for missing, tampered, expired or cross-deployment licenses", () => {
    const license = signedLicense();
    expect(() =>
      loadEnterpriseConfiguration(
        {
          INKSHADOW_DEPLOYMENT_MODE: "private",
          INKSHADOW_ENTERPRISE_DEPLOYMENT_ID: "customer-primary",
        },
        () => NOW,
      ),
    ).toThrow("verified Enterprise deployment license");
    expect(() =>
      loadEnterpriseConfiguration(
        {
          INKSHADOW_DEPLOYMENT_MODE: "private",
          INKSHADOW_ENTERPRISE_DEPLOYMENT_ID: "another-deployment",
          INKSHADOW_ENTERPRISE_LICENSE_JSON: license.serialized,
          INKSHADOW_ENTERPRISE_LICENSE_PUBLIC_KEY: license.publicKey,
        },
        () => NOW,
      ),
    ).toThrow("another deployment");
    const parsed = JSON.parse(license.serialized) as {
      payload: { validUntil: string };
      signature: string;
    };
    parsed.payload.validUntil = "2027-12-31T00:00:00.000Z";
    expect(() =>
      loadEnterpriseConfiguration(
        {
          INKSHADOW_DEPLOYMENT_MODE: "private",
          INKSHADOW_ENTERPRISE_DEPLOYMENT_ID: "customer-primary",
          INKSHADOW_ENTERPRISE_LICENSE_JSON: JSON.stringify(parsed),
          INKSHADOW_ENTERPRISE_LICENSE_PUBLIC_KEY: license.publicKey,
        },
        () => NOW,
      ),
    ).toThrow("signature");
    expect(() =>
      loadEnterpriseConfiguration(
        {
          INKSHADOW_DEPLOYMENT_MODE: "private",
          INKSHADOW_ENTERPRISE_DEPLOYMENT_ID: "customer-primary",
          INKSHADOW_ENTERPRISE_LICENSE_JSON: license.serialized,
          INKSHADOW_ENTERPRISE_LICENSE_PUBLIC_KEY: license.publicKey,
        },
        () => new Date("2028-01-01T00:00:00.000Z"),
      ),
    ).toThrow("not currently valid");
  });

  it("requires an independent metrics bearer token in private mode", () => {
    const license = signedLicense();
    const environment = {
      ...baseCloudEnvironment(),
      INKSHADOW_DEPLOYMENT_MODE: "private",
      INKSHADOW_ENTERPRISE_DEPLOYMENT_ID: "customer-primary",
      INKSHADOW_ENTERPRISE_LICENSE_JSON: license.serialized,
      INKSHADOW_ENTERPRISE_LICENSE_PUBLIC_KEY: license.publicKey,
    };
    expect(() => loadCloudApiConfiguration(environment)).toThrow(
      "INKSHADOW_METRICS_BEARER_TOKEN is required",
    );
    const configuration = loadCloudApiConfiguration({
      ...environment,
      INKSHADOW_METRICS_BEARER_TOKEN: "m".repeat(48),
    });
    expect(configuration.metricsBearerTokenHash).toHaveLength(32);
    expect(configuration.metricsBearerTokenHash?.toString("utf8")).not.toContain("m".repeat(32));
  });
});

function signedLicense(): { readonly publicKey: string; readonly serialized: string } {
  const keys = generateKeyPairSync("ed25519");
  const payload = {
    schemaVersion: 1,
    product: "inkshadow",
    licenseId: "license-primary",
    keyId: "enterprise-2026-01",
    deploymentId: "customer-primary",
    tier: "enterprise",
    issuedAt: "2026-01-01T00:00:00.000Z",
    notBefore: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z",
    capabilities: ["enterprise.policy", "enterprise.private_deployment", "enterprise.sso"],
    licensedTeamIds: [TEAM_ID],
  };
  return {
    publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    serialized: JSON.stringify({
      payload,
      signature: sign(null, Buffer.from(JSON.stringify(payload), "utf8"), keys.privateKey).toString(
        "base64url",
      ),
    }),
  };
}

function baseCloudEnvironment(): Readonly<Record<string, string>> {
  return {
    INKSHADOW_ALLOW_INSECURE_LOCAL_DATABASE: "true",
    INKSHADOW_ALLOW_INSECURE_LOCAL_HTTP: "true",
    INKSHADOW_CHALLENGE_CODE_KEY: Buffer.alloc(32, 0x31).toString("base64url"),
    INKSHADOW_CHALLENGE_DELIVERY_TOKEN: "d".repeat(32),
    INKSHADOW_CHALLENGE_DELIVERY_URL: "https://mailer.example.test/deliver",
    INKSHADOW_CHALLENGE_HASH_KEY: Buffer.alloc(32, 0x32).toString("base64url"),
    INKSHADOW_CLOUD_DATABASE_URL: "postgresql://inkshadow_test@127.0.0.1:55439/inkshadow_test",
    INKSHADOW_PAGE_CURSOR_KEY: Buffer.alloc(32, 0x33).toString("base64url"),
    INKSHADOW_SESSION_TOKEN_KEY: Buffer.alloc(32, 0x34).toString("base64url"),
    INKSHADOW_SYNC_CURSOR_KEY: Buffer.alloc(32, 0x35).toString("base64url"),
  };
}
