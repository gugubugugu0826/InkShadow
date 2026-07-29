import { createPublicKey, timingSafeEqual, verify } from "node:crypto";

import { CloudEmailAddressSchema } from "@inkshadow/contracts";

import type { EnterpriseOidcProviderConfiguration } from "./configuration.js";

export interface OidcDiscoveryMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

export interface VerifiedOidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly emailCanonical: string;
}

export interface EnterpriseOidcClientOptions {
  readonly cacheMs: number;
  readonly clock?: () => Date;
  readonly fetchImplementation?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

interface CachedValue<Value> {
  readonly expiresAtMs: number;
  readonly value: Value;
}

interface OidcJsonWebKey {
  readonly kid: string;
  readonly kty: "RSA";
  readonly n: string;
  readonly e: string;
  readonly alg?: "RS256";
  readonly use?: "sig";
  readonly key_ops?: readonly string[];
}

interface OidcTokenResponse {
  readonly idToken: string;
}

const MAXIMUM_JSON_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const CLOCK_SKEW_SECONDS = 60;

export class EnterpriseOidcClient {
  private readonly cacheMs: number;
  private readonly clock: () => Date;
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly discoveryCache = new Map<string, CachedValue<OidcDiscoveryMetadata>>();
  private readonly discoveryInflight = new Map<string, Promise<OidcDiscoveryMetadata>>();
  private readonly jwksCache = new Map<string, CachedValue<readonly OidcJsonWebKey[]>>();
  private readonly jwksInflight = new Map<string, Promise<readonly OidcJsonWebKey[]>>();

  public constructor(options: EnterpriseOidcClientOptions) {
    this.cacheMs = options.cacheMs;
    this.clock = options.clock ?? (() => new Date());
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.cacheMs) ||
      this.cacheMs < 60_000 ||
      this.cacheMs > 3_600_000 ||
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1_000 ||
      this.requestTimeoutMs > 30_000
    ) {
      throw new Error("Enterprise OIDC cache or request timeout is invalid.");
    }
  }

  public async discover(
    provider: EnterpriseOidcProviderConfiguration,
  ): Promise<OidcDiscoveryMetadata> {
    const nowMs = this.now().getTime();
    const cached = this.discoveryCache.get(provider.issuer);
    if (cached !== undefined && cached.expiresAtMs > nowMs) {
      return cached.value;
    }
    const inflight = this.discoveryInflight.get(provider.issuer);
    if (inflight !== undefined) {
      return inflight;
    }
    const promise = this.fetchDiscovery(provider)
      .then((value) => {
        this.discoveryCache.set(provider.issuer, {
          expiresAtMs: this.now().getTime() + this.cacheMs,
          value,
        });
        return value;
      })
      .finally(() => {
        this.discoveryInflight.delete(provider.issuer);
      });
    this.discoveryInflight.set(provider.issuer, promise);
    return promise;
  }

  public async exchangeAndVerify(options: {
    readonly provider: EnterpriseOidcProviderConfiguration;
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<VerifiedOidcIdentity> {
    const metadata = await this.discover(options.provider);
    const token = await this.exchangeCode(metadata, options);
    return this.verifyIdToken(token.idToken, metadata, options.provider, options.expectedNonce);
  }

  private async fetchDiscovery(
    provider: EnterpriseOidcProviderConfiguration,
  ): Promise<OidcDiscoveryMetadata> {
    const endpoint = discoveryEndpoint(provider.issuer);
    const value = await this.fetchJson(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!isRecord(value)) {
      throw new OidcTokenValidationError();
    }
    const issuer = requireString(value.issuer);
    const authorizationEndpoint = requireString(value.authorization_endpoint);
    const tokenEndpoint = requireString(value.token_endpoint);
    const jwksUri = requireString(value.jwks_uri);
    if (issuer !== provider.issuer) {
      throw new OidcTokenValidationError();
    }
    const issuerOrigin = new URL(provider.issuer).origin;
    for (const endpointValue of [authorizationEndpoint, tokenEndpoint, jwksUri]) {
      const parsed = requireSecureEndpoint(endpointValue);
      if (parsed.origin !== issuerOrigin) {
        throw new OidcTokenValidationError();
      }
    }
    if (
      !isStringArray(value.response_types_supported) ||
      !value.response_types_supported.includes("code") ||
      !isStringArray(value.id_token_signing_alg_values_supported) ||
      !value.id_token_signing_alg_values_supported.includes("RS256") ||
      !isStringArray(value.code_challenge_methods_supported) ||
      !value.code_challenge_methods_supported.includes("S256") ||
      !isStringArray(value.token_endpoint_auth_methods_supported) ||
      !value.token_endpoint_auth_methods_supported.includes("client_secret_basic")
    ) {
      throw new OidcTokenValidationError();
    }
    return Object.freeze({
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
    });
  }

  private async exchangeCode(
    metadata: OidcDiscoveryMetadata,
    options: {
      readonly provider: EnterpriseOidcProviderConfiguration;
      readonly code: string;
      readonly redirectUri: string;
      readonly codeVerifier: string;
    },
  ): Promise<OidcTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
    });
    const basic = Buffer.from(
      `${encodeURIComponent(options.provider.clientId)}:${encodeURIComponent(
        options.provider.clientSecret,
      )}`,
      "utf8",
    ).toString("base64");
    const value = await this.fetchJson(
      metadata.tokenEndpoint,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
      true,
    );
    if (
      !isRecord(value) ||
      value.token_type !== "Bearer" ||
      typeof value.id_token !== "string" ||
      value.id_token.length < 100 ||
      value.id_token.length > 32_768
    ) {
      throw new OidcTokenValidationError();
    }
    return { idToken: value.id_token };
  }

  private async verifyIdToken(
    token: string,
    metadata: OidcDiscoveryMetadata,
    provider: EnterpriseOidcProviderConfiguration,
    expectedNonce: string,
  ): Promise<VerifiedOidcIdentity> {
    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment))) {
      throw new OidcTokenValidationError();
    }
    const header = decodeJsonSegment(segments[0] ?? "", 8 * 1_024);
    const claims = decodeJsonSegment(segments[1] ?? "", 24 * 1_024);
    const signature = decodeBase64Url(segments[2] ?? "", 1, 1_024);
    if (
      !isRecord(header) ||
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      header.kid.length < 1 ||
      header.kid.length > 256 ||
      "crit" in header
    ) {
      throw new OidcTokenValidationError();
    }
    const keys = await this.getJwks(metadata);
    const key = keys.find((candidate) => candidate.kid === header.kid);
    if (key === undefined) {
      this.jwksCache.delete(metadata.jwksUri);
      const refreshed = await this.getJwks(metadata);
      const refreshedKey = refreshed.find((candidate) => candidate.kid === header.kid);
      if (refreshedKey === undefined) {
        throw new OidcTokenValidationError();
      }
      return this.verifyClaimsWithKey(
        segments,
        signature,
        claims,
        refreshedKey,
        provider,
        expectedNonce,
      );
    }
    return this.verifyClaimsWithKey(segments, signature, claims, key, provider, expectedNonce);
  }

  private verifyClaimsWithKey(
    segments: readonly string[],
    signature: Buffer,
    claims: unknown,
    key: OidcJsonWebKey,
    provider: EnterpriseOidcProviderConfiguration,
    expectedNonce: string,
  ): VerifiedOidcIdentity {
    let publicKey;
    try {
      publicKey = createPublicKey({
        key: {
          kty: "RSA",
          n: key.n,
          e: key.e,
        },
        format: "jwk",
      });
    } catch {
      throw new OidcTokenValidationError();
    }
    if (
      publicKey.asymmetricKeyType !== "rsa" ||
      (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048
    ) {
      throw new OidcTokenValidationError();
    }
    const signingInput = Buffer.from(`${segments[0] ?? ""}.${segments[1] ?? ""}`, "ascii");
    if (!verify("RSA-SHA256", signingInput, publicKey, signature) || !isRecord(claims)) {
      throw new OidcTokenValidationError();
    }
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    const issuer = requireString(claims.iss);
    const subject = requireString(claims.sub);
    const nonce = requireString(claims.nonce);
    const email = CloudEmailAddressSchema.safeParse(claims.email);
    const audience = parseAudience(claims.aud);
    if (
      issuer !== provider.issuer ||
      subject.length > 255 ||
      /[\u0000-\u001f\u007f]/u.test(subject) ||
      claims.email_verified !== true ||
      !email.success ||
      !audience.includes(provider.clientId) ||
      (audience.length > 1 && claims.azp !== provider.clientId) ||
      (claims.azp !== undefined && claims.azp !== provider.clientId) ||
      !constantTimeTextEqual(nonce, expectedNonce) ||
      !isNumericDate(claims.exp) ||
      claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS ||
      !isNumericDate(claims.iat) ||
      claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
      (claims.nbf !== undefined &&
        (!isNumericDate(claims.nbf) || claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS))
    ) {
      throw new OidcTokenValidationError();
    }
    return Object.freeze({
      emailCanonical: email.data,
      issuer,
      subject,
    });
  }

  private async getJwks(metadata: OidcDiscoveryMetadata): Promise<readonly OidcJsonWebKey[]> {
    const nowMs = this.now().getTime();
    const cached = this.jwksCache.get(metadata.jwksUri);
    if (cached !== undefined && cached.expiresAtMs > nowMs) {
      return cached.value;
    }
    const inflight = this.jwksInflight.get(metadata.jwksUri);
    if (inflight !== undefined) {
      return inflight;
    }
    const promise = this.fetchJwks(metadata)
      .then((value) => {
        this.jwksCache.set(metadata.jwksUri, {
          expiresAtMs: this.now().getTime() + this.cacheMs,
          value,
        });
        return value;
      })
      .finally(() => {
        this.jwksInflight.delete(metadata.jwksUri);
      });
    this.jwksInflight.set(metadata.jwksUri, promise);
    return promise;
  }

  private async fetchJwks(metadata: OidcDiscoveryMetadata): Promise<readonly OidcJsonWebKey[]> {
    const value = await this.fetchJson(metadata.jwksUri, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length > 64) {
      throw new OidcTokenValidationError();
    }
    const keys: OidcJsonWebKey[] = [];
    for (const candidate of value.keys) {
      const parsed = parseRsaVerificationJwk(candidate);
      if (parsed !== null) {
        keys.push(parsed);
      }
    }
    if (keys.length === 0 || new Set(keys.map((key) => key.kid)).size !== keys.length) {
      throw new OidcTokenValidationError();
    }
    return Object.freeze(keys);
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
    invalidOnClientError = false,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const response = await this.fetchImplementation(url, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (
          invalidOnClientError &&
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        ) {
          throw new OidcTokenValidationError();
        }
        throw new OidcProviderUnavailableError();
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json" && contentType !== "application/jwk-set+json") {
        throw new OidcTokenValidationError();
      }
      const contentLength = response.headers.get("content-length");
      if (
        contentLength !== null &&
        (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAXIMUM_JSON_BYTES)
      ) {
        throw new OidcTokenValidationError();
      }
      const bytes = await readBoundedResponseBytes(response, MAXIMUM_JSON_BYTES);
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new OidcTokenValidationError();
      } finally {
        bytes.fill(0);
      }
    } catch (error: unknown) {
      if (
        error instanceof OidcProviderUnavailableError ||
        error instanceof OidcTokenValidationError
      ) {
        throw error;
      }
      throw new OidcProviderUnavailableError();
    } finally {
      clearTimeout(timeout);
    }
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The Enterprise OIDC clock returned an invalid timestamp.");
    }
    return new Date(value);
  }
}

export class OidcProviderUnavailableError extends Error {
  public constructor() {
    super("Enterprise OIDC provider unavailable.");
    this.name = "OidcProviderUnavailableError";
  }
}

export class OidcTokenValidationError extends Error {
  public constructor() {
    super("Enterprise OIDC response invalid.");
    this.name = "OidcTokenValidationError";
  }
}

export function discoveryEndpoint(issuerValue: string): string {
  const issuer = new URL(issuerValue);
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/u, "");
  issuer.pathname = `${path}/.well-known/openid-configuration`;
  issuer.search = "";
  issuer.hash = "";
  return issuer.toString();
}

function requireSecureEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new OidcTokenValidationError();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== ""
  ) {
    throw new OidcTokenValidationError();
  }
  return endpoint;
}

async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {
          // The response is already rejected; cancellation is best effort.
        });
        throw new OidcTokenValidationError();
      }
      chunks.push(result.value);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  } finally {
    reader.releaseLock();
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}

function decodeJsonSegment(value: string, maximumBytes: number): unknown {
  const decoded = decodeBase64Url(value, 1, maximumBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)) as unknown;
  } catch {
    throw new OidcTokenValidationError();
  } finally {
    decoded.fill(0);
  }
}

function decodeBase64Url(value: string, minimumBytes: number, maximumBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new OidcTokenValidationError();
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length < minimumBytes ||
    decoded.length > maximumBytes ||
    decoded.toString("base64url") !== value
  ) {
    throw new OidcTokenValidationError();
  }
  return decoded;
}

function parseAudience(value: unknown): readonly string[] {
  if (typeof value === "string" && value.length > 0 && value.length <= 200) {
    return [value];
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 16 &&
    value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 200) &&
    new Set(value).size === value.length
  ) {
    return value as string[];
  }
  throw new OidcTokenValidationError();
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isNumericDate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every((item) => typeof item === "string" && item.length <= 256)
  );
}

function requireString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OidcTokenValidationError();
  }
  return value;
}

function parseRsaVerificationJwk(value: unknown): OidcJsonWebKey | null {
  if (
    !isRecord(value) ||
    value.kty !== "RSA" ||
    typeof value.kid !== "string" ||
    value.kid.length < 1 ||
    value.kid.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value.kid) ||
    typeof value.n !== "string" ||
    typeof value.e !== "string" ||
    (value.alg !== undefined && value.alg !== "RS256") ||
    (value.use !== undefined && value.use !== "sig") ||
    (value.key_ops !== undefined &&
      (!isStringArray(value.key_ops) ||
        value.key_ops.length !== 1 ||
        value.key_ops[0] !== "verify"))
  ) {
    return null;
  }
  const modulus = decodeCanonicalBase64Url(value.n, 256, 1_024);
  const exponent = decodeCanonicalBase64Url(value.e, 1, 4);
  if (
    modulus === null ||
    exponent === null ||
    modulus[0] === 0 ||
    exponent[0] === 0 ||
    readUnsignedInteger(exponent) < 3 ||
    readUnsignedInteger(exponent) % 2 !== 1
  ) {
    return null;
  }
  return {
    kty: "RSA",
    kid: value.kid,
    n: value.n,
    e: value.e,
    ...(value.alg === undefined ? {} : { alg: value.alg }),
    ...(value.use === undefined ? {} : { use: value.use }),
    ...(value.key_ops === undefined ? {} : { key_ops: value.key_ops }),
  };
}

function decodeCanonicalBase64Url(
  value: string,
  minimumBytes: number,
  maximumBytes: number,
): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= minimumBytes &&
    decoded.length <= maximumBytes &&
    decoded.toString("base64url") === value
    ? decoded
    : null;
}

function readUnsignedInteger(value: Buffer): number {
  let result = 0;
  for (const byte of value) {
    result = result * 256 + byte;
  }
  return result;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
