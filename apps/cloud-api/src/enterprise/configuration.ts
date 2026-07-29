import { createHash, createPublicKey, verify } from "node:crypto";

import { CloudEnterpriseRedirectUriSchema, UuidV7Schema } from "@inkshadow/contracts";
import type { ProductCapability } from "@inkshadow/access-core";

import { parseBase64UrlSecret } from "../security/tokens.js";

const ENTERPRISE_CAPABILITIES = [
  "enterprise.policy",
  "enterprise.private_deployment",
  "enterprise.sso",
] as const satisfies readonly ProductCapability[];
const ENTERPRISE_CAPABILITY_SET = new Set<string>(ENTERPRISE_CAPABILITIES);

const LICENSE_PAYLOAD_KEYS = [
  "schemaVersion",
  "product",
  "licenseId",
  "keyId",
  "deploymentId",
  "tier",
  "issuedAt",
  "notBefore",
  "validUntil",
  "capabilities",
  "licensedTeamIds",
] as const;

const LICENSE_ENVELOPE_KEYS = ["payload", "signature"] as const;
const OIDC_PROVIDER_KEYS = [
  "teamId",
  "issuer",
  "clientId",
  "clientSecretEnvironment",
  "redirectUris",
] as const;

export interface EnterpriseDeploymentLicense {
  readonly schemaVersion: 1;
  readonly product: "inkshadow";
  readonly licenseId: string;
  readonly keyId: string;
  readonly deploymentId: string;
  readonly tier: "enterprise";
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly validUntil: string;
  readonly capabilities: readonly ProductCapability[];
  readonly licensedTeamIds: readonly string[];
  readonly fingerprintSha256: string;
}

export interface EnterpriseOidcProviderConfiguration {
  readonly teamId: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUris: readonly string[];
}

export interface EnterpriseConfiguration {
  readonly deploymentId: string;
  readonly flowKey: Buffer | null;
  readonly flowLifetimeMs: number;
  readonly metadataCacheMs: number;
  readonly providers: ReadonlyMap<string, EnterpriseOidcProviderConfiguration>;
  readonly license: EnterpriseDeploymentLicense | null;
}

export interface EnterpriseConfigurationResult {
  readonly deploymentMode: "hosted" | "private";
  readonly enterprise: EnterpriseConfiguration;
}

export function loadEnterpriseConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  clock: () => Date = () => new Date(),
): EnterpriseConfigurationResult {
  const deploymentMode = parseDeploymentMode(environment.INKSHADOW_DEPLOYMENT_MODE);
  const deploymentId = optionalIdentifier(
    environment.INKSHADOW_ENTERPRISE_DEPLOYMENT_ID,
    "INKSHADOW_ENTERPRISE_DEPLOYMENT_ID",
  );
  const licenseJson = trimmed(environment.INKSHADOW_ENTERPRISE_LICENSE_JSON);
  const licensePublicKey = trimmed(environment.INKSHADOW_ENTERPRISE_LICENSE_PUBLIC_KEY);
  if ((licenseJson === null) !== (licensePublicKey === null)) {
    throw new Error(
      "INKSHADOW_ENTERPRISE_LICENSE_JSON and INKSHADOW_ENTERPRISE_LICENSE_PUBLIC_KEY must be configured together.",
    );
  }
  if (licenseJson !== null && deploymentId === null) {
    throw new Error("INKSHADOW_ENTERPRISE_DEPLOYMENT_ID is required with an Enterprise license.");
  }
  const license =
    licenseJson === null || licensePublicKey === null || deploymentId === null
      ? null
      : verifyEnterpriseLicense(licenseJson, licensePublicKey, deploymentId);

  const providers = parseOidcProviders(environment, license);
  const flowKeyValue = trimmed(environment.INKSHADOW_ENTERPRISE_OIDC_FLOW_KEY);
  if (providers.size > 0 && flowKeyValue === null) {
    throw new Error(
      "INKSHADOW_ENTERPRISE_OIDC_FLOW_KEY is required when an OIDC provider is configured.",
    );
  }
  const flowKey =
    flowKeyValue === null
      ? null
      : parseBase64UrlSecret("INKSHADOW_ENTERPRISE_OIDC_FLOW_KEY", flowKeyValue);
  const metadataCacheMs =
    parseBoundedInteger(
      "INKSHADOW_ENTERPRISE_OIDC_METADATA_CACHE_SECONDS",
      environment.INKSHADOW_ENTERPRISE_OIDC_METADATA_CACHE_SECONDS,
      300,
      60,
      3_600,
    ) * 1_000;
  const flowLifetimeMs =
    parseBoundedInteger(
      "INKSHADOW_ENTERPRISE_OIDC_FLOW_LIFETIME_SECONDS",
      environment.INKSHADOW_ENTERPRISE_OIDC_FLOW_LIFETIME_SECONDS,
      600,
      60,
      900,
    ) * 1_000;

  if (deploymentMode === "private") {
    if (license === null) {
      throw new Error("Private deployment requires a verified Enterprise deployment license.");
    }
    if (!license.capabilities.includes("enterprise.private_deployment")) {
      throw new Error("The Enterprise license does not grant enterprise.private_deployment.");
    }
    const now = requireClock(clock);
    if (
      now.getTime() < Date.parse(license.notBefore) ||
      now.getTime() > Date.parse(license.validUntil)
    ) {
      throw new Error("The Enterprise deployment license is not currently valid.");
    }
  }

  return {
    deploymentMode,
    enterprise: {
      deploymentId: deploymentId ?? "hosted-unlicensed",
      flowKey,
      flowLifetimeMs,
      metadataCacheMs,
      providers,
      license,
    },
  };
}

export function enterpriseLicenseIsCurrentlyValid(
  configuration: EnterpriseConfiguration,
  at: Date,
  capability: (typeof ENTERPRISE_CAPABILITIES)[number],
  teamId?: string,
): boolean {
  const license = configuration.license;
  return (
    license !== null &&
    Date.parse(license.notBefore) <= at.getTime() &&
    at.getTime() <= Date.parse(license.validUntil) &&
    license.capabilities.includes(capability) &&
    (teamId === undefined || license.licensedTeamIds.includes(teamId))
  );
}

function verifyEnterpriseLicense(
  serialized: string,
  publicKeyValue: string,
  expectedDeploymentId: string,
): EnterpriseDeploymentLicense {
  if (serialized.length > 64 * 1_024) {
    throw new Error("INKSHADOW_ENTERPRISE_LICENSE_JSON is too large.");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("INKSHADOW_ENTERPRISE_LICENSE_JSON is not valid JSON.");
  }
  if (
    !isRecord(envelope) ||
    !hasExactKeys(envelope, LICENSE_ENVELOPE_KEYS) ||
    !isRecord(envelope.payload) ||
    !hasExactKeys(envelope.payload, LICENSE_PAYLOAD_KEYS) ||
    typeof envelope.signature !== "string"
  ) {
    throw new Error("The Enterprise deployment license has an invalid shape.");
  }
  const payload = parseLicensePayload(envelope.payload, expectedDeploymentId);
  const signature = decodeBase64Url(
    envelope.signature,
    "Enterprise deployment license signature",
    64,
    128,
  );
  const publicKeyBytes = decodeBase64Url(
    publicKeyValue,
    "Enterprise deployment license public key",
    32,
    1_024,
  );
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: publicKeyBytes,
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error("The Enterprise deployment license public key is invalid.");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("The Enterprise deployment license public key must use Ed25519.");
  }
  const canonical = Buffer.from(canonicalizeLicensePayload(payload), "utf8");
  if (!verify(null, canonical, publicKey, signature)) {
    throw new Error("The Enterprise deployment license signature is invalid.");
  }
  return Object.freeze({
    ...payload,
    fingerprintSha256: sha256Hex(canonical),
  });
}

function parseLicensePayload(
  value: Readonly<Record<string, unknown>>,
  expectedDeploymentId: string,
): Omit<EnterpriseDeploymentLicense, "fingerprintSha256"> {
  if (
    value.schemaVersion !== 1 ||
    value.product !== "inkshadow" ||
    value.tier !== "enterprise" ||
    typeof value.licenseId !== "string" ||
    typeof value.keyId !== "string" ||
    typeof value.deploymentId !== "string" ||
    typeof value.issuedAt !== "string" ||
    typeof value.notBefore !== "string" ||
    typeof value.validUntil !== "string" ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((item) => typeof item === "string") ||
    !Array.isArray(value.licensedTeamIds) ||
    !value.licensedTeamIds.every((item) => typeof item === "string")
  ) {
    throw new Error("The Enterprise deployment license payload is invalid.");
  }
  const licenseId = requireIdentifier(value.licenseId, "Enterprise license id");
  const keyId = requireIdentifier(value.keyId, "Enterprise license key id");
  const deploymentId = requireIdentifier(value.deploymentId, "Enterprise deployment id");
  if (deploymentId !== expectedDeploymentId) {
    throw new Error("The Enterprise deployment license is bound to another deployment.");
  }
  const issuedAt = requireIsoUtc(value.issuedAt, "Enterprise license issuedAt");
  const notBefore = requireIsoUtc(value.notBefore, "Enterprise license notBefore");
  const validUntil = requireIsoUtc(value.validUntil, "Enterprise license validUntil");
  if (
    Date.parse(issuedAt) > Date.parse(notBefore) ||
    Date.parse(notBefore) > Date.parse(validUntil)
  ) {
    throw new Error("The Enterprise deployment license time window is invalid.");
  }
  const capabilities = [...value.capabilities] as ProductCapability[];
  if (
    !isStrictlySortedUnique(capabilities) ||
    capabilities.some((capability) => !ENTERPRISE_CAPABILITY_SET.has(capability))
  ) {
    throw new Error("The Enterprise deployment license capabilities are unsupported or unsorted.");
  }
  const licensedTeamIds = [...value.licensedTeamIds];
  if (
    licensedTeamIds.length === 0 ||
    licensedTeamIds.length > 1_024 ||
    !isStrictlySortedUnique(licensedTeamIds) ||
    licensedTeamIds.some((teamId) => !UuidV7Schema.safeParse(teamId).success)
  ) {
    throw new Error("The Enterprise deployment license team scope is invalid.");
  }
  return {
    schemaVersion: 1,
    product: "inkshadow",
    licenseId,
    keyId,
    deploymentId,
    tier: "enterprise",
    issuedAt,
    notBefore,
    validUntil,
    capabilities: Object.freeze(capabilities),
    licensedTeamIds: Object.freeze(licensedTeamIds),
  };
}

function parseOidcProviders(
  environment: Readonly<Record<string, string | undefined>>,
  license: EnterpriseDeploymentLicense | null,
): ReadonlyMap<string, EnterpriseOidcProviderConfiguration> {
  const serialized = trimmed(environment.INKSHADOW_ENTERPRISE_OIDC_PROVIDERS_JSON);
  if (serialized === null) {
    return new Map();
  }
  if (!license?.capabilities.includes("enterprise.sso")) {
    throw new Error("OIDC providers require an Enterprise license granting enterprise.sso.");
  }
  if (serialized.length > 256 * 1_024) {
    throw new Error("INKSHADOW_ENTERPRISE_OIDC_PROVIDERS_JSON is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("INKSHADOW_ENTERPRISE_OIDC_PROVIDERS_JSON is not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) {
    throw new Error("Enterprise OIDC providers must contain between 1 and 64 entries.");
  }
  const providers = new Map<string, EnterpriseOidcProviderConfiguration>();
  for (const value of parsed) {
    if (!isRecord(value) || !hasExactKeys(value, OIDC_PROVIDER_KEYS)) {
      throw new Error("An Enterprise OIDC provider has an invalid shape.");
    }
    if (
      typeof value.teamId !== "string" ||
      !UuidV7Schema.safeParse(value.teamId).success ||
      typeof value.issuer !== "string" ||
      typeof value.clientId !== "string" ||
      typeof value.clientSecretEnvironment !== "string" ||
      !Array.isArray(value.redirectUris) ||
      !value.redirectUris.every((item) => typeof item === "string")
    ) {
      throw new Error("An Enterprise OIDC provider is invalid.");
    }
    if (!license.licensedTeamIds.includes(value.teamId)) {
      throw new Error("An Enterprise OIDC provider is outside the licensed team scope.");
    }
    const issuer = requireHttpsIssuer(value.issuer);
    const clientId = value.clientId.trim();
    if (clientId.length < 1 || clientId.length > 200 || /[\u0000-\u001f\u007f]/u.test(clientId)) {
      throw new Error("An Enterprise OIDC client id is invalid.");
    }
    if (!/^INKSHADOW_OIDC_CLIENT_SECRET_[A-Z0-9_]{1,64}$/u.test(value.clientSecretEnvironment)) {
      throw new Error("An Enterprise OIDC client-secret environment name is invalid.");
    }
    const clientSecret = trimmed(environment[value.clientSecretEnvironment]);
    if (
      clientSecret === null ||
      clientSecret.length < 16 ||
      clientSecret.length > 4_096 ||
      /[\r\n]/u.test(clientSecret)
    ) {
      throw new Error(
        `The Enterprise OIDC client secret in ${value.clientSecretEnvironment} is missing or invalid.`,
      );
    }
    const redirectUris = value.redirectUris.map((uri) => {
      const result = CloudEnterpriseRedirectUriSchema.safeParse(uri);
      if (!result.success || result.data !== uri) {
        throw new Error("An Enterprise OIDC redirect URI is invalid or non-canonical.");
      }
      return result.data;
    });
    if (
      redirectUris.length === 0 ||
      redirectUris.length > 16 ||
      !isStrictlySortedUnique(redirectUris)
    ) {
      throw new Error("Enterprise OIDC redirect URIs must be unique and sorted.");
    }
    if (providers.has(value.teamId)) {
      throw new Error("Only one Enterprise OIDC provider may be configured per team.");
    }
    providers.set(
      value.teamId,
      Object.freeze({
        teamId: value.teamId,
        issuer,
        clientId,
        clientSecret,
        redirectUris: Object.freeze(redirectUris),
      }),
    );
  }
  return providers;
}

function canonicalizeLicensePayload(
  payload: Omit<EnterpriseDeploymentLicense, "fingerprintSha256">,
): string {
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    product: payload.product,
    licenseId: payload.licenseId,
    keyId: payload.keyId,
    deploymentId: payload.deploymentId,
    tier: payload.tier,
    issuedAt: payload.issuedAt,
    notBefore: payload.notBefore,
    validUntil: payload.validUntil,
    capabilities: payload.capabilities,
    licensedTeamIds: payload.licensedTeamIds,
  });
}

function requireHttpsIssuer(value: string): string {
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw new Error("An Enterprise OIDC issuer is invalid.");
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.search !== "" ||
    issuer.hash !== "" ||
    issuer.pathname.includes("/../") ||
    issuer.pathname.includes("/./")
  ) {
    throw new Error("An Enterprise OIDC issuer must be credential-free HTTPS.");
  }
  const canonical = issuer.toString();
  if (canonical !== value) {
    throw new Error("An Enterprise OIDC issuer must use its canonical URL.");
  }
  return canonical;
}

function parseDeploymentMode(value: string | undefined): "hosted" | "private" {
  const normalized = value?.trim() ?? "";
  if (normalized === "" || normalized === "hosted") {
    return "hosted";
  }
  if (normalized === "private") {
    return "private";
  }
  throw new Error("INKSHADOW_DEPLOYMENT_MODE must be hosted or private.");
}

function optionalIdentifier(value: string | undefined, name: string): string | null {
  const normalized = trimmed(value);
  return normalized === null ? null : requireIdentifier(normalized, name);
}

function requireIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireIsoUtc(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO 8601 UTC timestamp.`);
  }
  return value;
}

function parseBoundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") {
    return fallback;
  }
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${name} must be an integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return parsed;
}

function decodeBase64Url(
  value: string,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} must use unpadded base64url.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length < minimumBytes ||
    decoded.length > maximumBytes ||
    decoded.toString("base64url") !== value
  ) {
    throw new Error(`${label} has an invalid length or encoding.`);
  }
  return decoded;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function trimmed(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? null : normalized;
}

function requireClock(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("The Enterprise configuration clock returned an invalid time.");
  }
  return value;
}

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
