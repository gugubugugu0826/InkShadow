import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  EnterpriseOidcClient,
  OidcProviderUnavailableError,
  OidcTokenValidationError,
  discoveryEndpoint,
} from "../src/enterprise/oidc-client.js";
import type { EnterpriseOidcProviderConfiguration } from "../src/enterprise/configuration.js";

const ISSUER = "https://idp.example.test/";
const CLIENT_ID = "inkshadow-private";
const NOW = new Date("2026-07-28T10:00:00.000Z");
const NONCE = "n".repeat(43);

describe("Enterprise OIDC client", () => {
  it("appends discovery metadata to a tenant-scoped issuer path", () => {
    expect(discoveryEndpoint("https://idp.example.test/tenant/v2.0/")).toBe(
      "https://idp.example.test/tenant/v2.0/.well-known/openid-configuration",
    );
  });

  it("coalesces discovery, exchanges with PKCE and verifies signed identity claims", async () => {
    const signing = signingFixture();
    const idToken = jwt(signing, {
      iss: ISSUER,
      sub: "idp-subject-123",
      aud: CLIENT_ID,
      exp: Math.floor(NOW.getTime() / 1_000) + 600,
      iat: Math.floor(NOW.getTime() / 1_000),
      nonce: NONCE,
      email: "writer@example.com",
      email_verified: true,
    });
    let discoveryRequests = 0;
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      const url = fetchInputUrl(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        discoveryRequests += 1;
        return Promise.resolve(json(discovery()));
      }
      if (url === `${ISSUER}oauth/token`) {
        expect(init).toMatchObject({
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          method: "POST",
        });
        expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /u);
        const body = init?.body;
        expect(typeof body).toBe("string");
        if (typeof body !== "string") {
          return Promise.reject(new TypeError("OIDC token request body must be a string."));
        }
        expect(body).toContain("code_verifier=");
        return Promise.resolve(json({ token_type: "Bearer", id_token: idToken }));
      }
      if (url === `${ISSUER}.well-known/jwks.json`) {
        return Promise.resolve(json({ keys: [signing.publicJwk] }, "application/jwk-set+json"));
      }
      return Promise.reject(new Error(`Unexpected OIDC URL: ${url}`));
    });
    const client = new EnterpriseOidcClient({
      cacheMs: 60_000,
      clock: () => NOW,
      fetchImplementation,
    });

    await Promise.all([client.discover(provider()), client.discover(provider())]);
    const verified = await client.exchangeAndVerify({
      provider: provider(),
      code: "authorization-code",
      redirectUri: "inkshadow://enterprise/sso/callback",
      codeVerifier: "v".repeat(43),
      expectedNonce: NONCE,
    });

    expect(discoveryRequests).toBe(1);
    expect(verified).toEqual({
      issuer: ISSUER,
      subject: "idp-subject-123",
      emailCanonical: "writer@example.com",
    });
  });

  it("rejects nonce mismatch and treats invalid authorization codes as token failures", async () => {
    const signing = signingFixture();
    const idToken = jwt(signing, {
      iss: ISSUER,
      sub: "subject",
      aud: CLIENT_ID,
      exp: Math.floor(NOW.getTime() / 1_000) + 600,
      iat: Math.floor(NOW.getTime() / 1_000),
      nonce: "different-nonce-value-that-is-long-enough",
      email: "writer@example.com",
      email_verified: true,
    });
    const client = oidcClient((url) => {
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json(discovery());
      }
      if (url === `${ISSUER}oauth/token`) {
        return json({ token_type: "Bearer", id_token: idToken });
      }
      return json({ keys: [signing.publicJwk] }, "application/jwk-set+json");
    });
    await expect(
      client.exchangeAndVerify({
        provider: provider(),
        code: "authorization-code",
        redirectUri: "inkshadow://enterprise/sso/callback",
        codeVerifier: "v".repeat(43),
        expectedNonce: NONCE,
      }),
    ).rejects.toBeInstanceOf(OidcTokenValidationError);

    const invalidCodeClient = oidcClient((url) =>
      url.endsWith("/.well-known/openid-configuration")
        ? json(discovery())
        : new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
    );
    await expect(
      invalidCodeClient.exchangeAndVerify({
        provider: provider(),
        code: "already-used-code",
        redirectUri: "inkshadow://enterprise/sso/callback",
        codeVerifier: "v".repeat(43),
        expectedNonce: NONCE,
      }),
    ).rejects.toBeInstanceOf(OidcTokenValidationError);
  });

  it("does not use discovery metadata after cache expiry when the provider is down", async () => {
    let clock = new Date(NOW);
    let available = true;
    const client = new EnterpriseOidcClient({
      cacheMs: 60_000,
      clock: () => clock,
      fetchImplementation: vi.fn<typeof fetch>(() =>
        available
          ? Promise.resolve(json(discovery()))
          : Promise.reject(new Error("network unavailable")),
      ),
    });
    await expect(client.discover(provider())).resolves.toMatchObject({ issuer: ISSUER });
    available = false;
    clock = new Date(NOW.getTime() + 60_001);
    await expect(client.discover(provider())).rejects.toBeInstanceOf(OidcProviderUnavailableError);
  });

  it("rejects discovery endpoints that leave the configured HTTPS issuer origin", async () => {
    const client = oidcClient(() =>
      json({
        ...discovery(),
        token_endpoint: "https://metadata.internal.example/token",
      }),
    );
    await expect(client.discover(provider())).rejects.toBeInstanceOf(OidcTokenValidationError);

    const insecure = oidcClient(() =>
      json({
        ...discovery(),
        jwks_uri: "http://idp.example.test/.well-known/jwks.json",
      }),
    );
    await expect(insecure.discover(provider())).rejects.toBeInstanceOf(OidcTokenValidationError);
  });

  it("rejects undersized RSA signing keys even when the token signature is valid", async () => {
    const signing = signingFixture(1_024);
    const idToken = jwt(signing, {
      iss: ISSUER,
      sub: "subject",
      aud: CLIENT_ID,
      exp: Math.floor(NOW.getTime() / 1_000) + 600,
      iat: Math.floor(NOW.getTime() / 1_000),
      nonce: NONCE,
      email: "writer@example.com",
      email_verified: true,
    });
    const client = oidcClient((url) => {
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json(discovery());
      }
      if (url === `${ISSUER}oauth/token`) {
        return json({ token_type: "Bearer", id_token: idToken });
      }
      return json({ keys: [signing.publicJwk] }, "application/jwk-set+json");
    });
    await expect(
      client.exchangeAndVerify({
        provider: provider(),
        code: "authorization-code",
        redirectUri: "inkshadow://enterprise/sso/callback",
        codeVerifier: "v".repeat(43),
        expectedNonce: NONCE,
      }),
    ).rejects.toBeInstanceOf(OidcTokenValidationError);
  });

  it("rejects oversized JSON before buffering it", async () => {
    const client = new EnterpriseOidcClient({
      cacheMs: 60_000,
      clock: () => NOW,
      fetchImplementation: vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response("{}", {
            headers: {
              "content-length": String(1024 * 1024 + 1),
              "content-type": "application/json",
            },
          }),
        ),
      ),
    });
    await expect(client.discover(provider())).rejects.toBeInstanceOf(OidcTokenValidationError);
  });
});

function oidcClient(
  responder: (url: string) => Response | Promise<Response>,
): EnterpriseOidcClient {
  return new EnterpriseOidcClient({
    cacheMs: 60_000,
    clock: () => NOW,
    fetchImplementation: vi.fn<typeof fetch>((input) =>
      Promise.resolve(responder(fetchInputUrl(input))),
    ),
  });
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function provider(): EnterpriseOidcProviderConfiguration {
  return {
    teamId: "018f0d7a-3b2c-7abc-8def-000000000001",
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: "s".repeat(32),
    redirectUris: ["inkshadow://enterprise/sso/callback"],
  };
}

function discovery() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}oauth/authorize`,
    token_endpoint: `${ISSUER}oauth/token`,
    jwks_uri: `${ISSUER}.well-known/jwks.json`,
    response_types_supported: ["code"],
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
  };
}

function signingFixture(modulusLength = 2_048): {
  readonly privateKey: KeyObject;
  readonly publicJwk: {
    readonly kid: string;
    readonly kty: "RSA";
    readonly n: string;
    readonly e: string;
    readonly alg: "RS256";
    readonly use: "sig";
  };
} {
  const keys = generateKeyPairSync("rsa", { modulusLength });
  const exported = keys.publicKey.export({ format: "jwk" });
  if (exported.kty !== "RSA" || exported.n === undefined || exported.e === undefined) {
    throw new Error("RSA fixture export failed.");
  }
  return {
    privateKey: keys.privateKey,
    publicJwk: {
      kid: "test-key-1",
      kty: "RSA",
      n: exported.n,
      e: exported.e,
      alg: "RS256",
      use: "sig",
    },
  };
}

function jwt(
  signing: ReturnType<typeof signingFixture>,
  claims: Readonly<Record<string, unknown>>,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: signing.publicJwk.kid, typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`, "ascii"),
    signing.privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function json(value: unknown, contentType = "application/json"): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": contentType },
  });
}
