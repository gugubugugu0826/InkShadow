import { createHash } from "node:crypto";

import { parseBase64UrlSecret } from "./security/tokens.js";
import {
  loadCloudMaintenanceConfiguration,
  type CloudMaintenanceConfiguration,
} from "./maintenance/configuration.js";
import {
  loadCloudDeletionConfiguration,
  type CloudDeletionConfiguration,
} from "./deletion/configuration.js";
import {
  loadCloudTeamInvitationDeliveryConfiguration,
  type CloudTeamInvitationDeliveryConfiguration,
} from "./team/configuration.js";
import {
  loadEnterpriseConfiguration,
  type EnterpriseConfiguration,
} from "./enterprise/configuration.js";
import {
  loadCloudRuntimeDatabaseConfiguration,
  type CloudAppEnvironment,
} from "./postgres/configuration.js";

export interface CloudApiConfiguration {
  readonly appEnvironment: CloudAppEnvironment;
  readonly challengeCodeKey: Buffer;
  readonly challengeDeliveryEndpoint: string;
  readonly challengeDeliveryToken: string;
  readonly challengeHashKey: Buffer;
  readonly databaseCertificateAuthority: string | undefined;
  readonly databaseMigrationRole: string;
  readonly databaseRolesSeparated: boolean;
  readonly databaseRuntimeRole: string;
  readonly databaseUrl: string;
  readonly deletion: CloudDeletionConfiguration;
  readonly deploymentMode: "hosted" | "private";
  readonly enterprise: EnterpriseConfiguration;
  readonly host: string;
  readonly maintenance: CloudMaintenanceConfiguration;
  readonly marketplace: {
    readonly cursorKey: Buffer | null;
    readonly enabled: boolean;
  };
  readonly minimumClientVersion: string;
  readonly metricsBearerTokenHash: Buffer | null;
  readonly pageCursorKey: Buffer;
  readonly port: number;
  readonly requireDatabaseTls: boolean;
  readonly requireHttps: boolean;
  readonly sessionTokenKey: Buffer;
  readonly syncCursorKey: Buffer;
  readonly teamInvitationDelivery: CloudTeamInvitationDeliveryConfiguration | null;
  readonly trustedProxies: false | readonly string[];
}

export function loadCloudApiConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CloudApiConfiguration {
  const databaseConfiguration = loadCloudRuntimeDatabaseConfiguration(environment);
  const { appEnvironment } = databaseConfiguration;
  const enterpriseResult = loadEnterpriseConfiguration(environment);
  const configuredHost = environment.INKSHADOW_CLOUD_HOST?.trim();
  const host = configuredHost === undefined || configuredHost === "" ? "127.0.0.1" : configuredHost;
  const port = parsePort(environment.INKSHADOW_CLOUD_PORT ?? "8787");
  const allowInsecureLocalHttp = parseBoolean(
    "INKSHADOW_ALLOW_INSECURE_LOCAL_HTTP",
    environment.INKSHADOW_ALLOW_INSECURE_LOCAL_HTTP,
    false,
  );
  if (allowInsecureLocalHttp && !isLoopbackHost(host)) {
    throw new Error("Insecure cloud HTTP can be enabled only on a loopback host.");
  }
  const requireHttps = !allowInsecureLocalHttp;
  const trustedProxies = parseTrustedProxies(
    environment.INKSHADOW_TRUSTED_PROXY_ADDRESSES,
    requireHttps,
  );
  if (appEnvironment === "production" && allowInsecureLocalHttp) {
    throw new Error("Production cloud deployments cannot enable insecure local overrides.");
  }
  const challengeDeliveryEndpoint = required(environment, "INKSHADOW_CHALLENGE_DELIVERY_URL");
  const deliveryUrl = new URL(challengeDeliveryEndpoint);
  if (
    deliveryUrl.protocol !== "https:" ||
    deliveryUrl.username !== "" ||
    deliveryUrl.password !== ""
  ) {
    throw new Error("INKSHADOW_CHALLENGE_DELIVERY_URL must be credential-free HTTPS.");
  }
  const challengeDeliveryToken = required(environment, "INKSHADOW_CHALLENGE_DELIVERY_TOKEN");
  if (
    challengeDeliveryToken.length < 32 ||
    challengeDeliveryToken.length > 4_096 ||
    /[\r\n]/u.test(challengeDeliveryToken)
  ) {
    throw new Error("INKSHADOW_CHALLENGE_DELIVERY_TOKEN is invalid.");
  }
  const configuredMinimumClientVersion = environment.INKSHADOW_MINIMUM_CLIENT_VERSION?.trim();
  const minimumClientVersion =
    configuredMinimumClientVersion === undefined || configuredMinimumClientVersion === ""
      ? "0.1.0"
      : configuredMinimumClientVersion;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(minimumClientVersion)) {
    throw new Error("INKSHADOW_MINIMUM_CLIENT_VERSION must be semantic version X.Y.Z.");
  }
  const challengeCodeKey = parseBase64UrlSecret(
    "INKSHADOW_CHALLENGE_CODE_KEY",
    required(environment, "INKSHADOW_CHALLENGE_CODE_KEY"),
  );
  const challengeHashKey = parseBase64UrlSecret(
    "INKSHADOW_CHALLENGE_HASH_KEY",
    required(environment, "INKSHADOW_CHALLENGE_HASH_KEY"),
  );
  const pageCursorKey = parseBase64UrlSecret(
    "INKSHADOW_PAGE_CURSOR_KEY",
    required(environment, "INKSHADOW_PAGE_CURSOR_KEY"),
  );
  const sessionTokenKey = parseBase64UrlSecret(
    "INKSHADOW_SESSION_TOKEN_KEY",
    required(environment, "INKSHADOW_SESSION_TOKEN_KEY"),
  );
  const syncCursorKey = parseBase64UrlSecret(
    "INKSHADOW_SYNC_CURSOR_KEY",
    required(environment, "INKSHADOW_SYNC_CURSOR_KEY"),
  );
  const teamInvitationDelivery = loadCloudTeamInvitationDeliveryConfiguration(environment);
  const teamInvitationEncryptionKeys =
    teamInvitationDelivery === null ? [] : Object.values(teamInvitationDelivery.encryptionKeys);
  const metricsBearerToken = parseMetricsBearerToken(
    environment.INKSHADOW_METRICS_BEARER_TOKEN,
    enterpriseResult.deploymentMode === "private",
  );
  const marketplaceEnabled = parseBoolean(
    "INKSHADOW_COMMUNITY_MARKETPLACE_ENABLED",
    environment.INKSHADOW_COMMUNITY_MARKETPLACE_ENABLED,
    false,
  );
  const marketplaceCursorKeyValue = environment.INKSHADOW_MARKETPLACE_CURSOR_KEY?.trim();
  if (
    marketplaceEnabled &&
    (marketplaceCursorKeyValue === undefined || marketplaceCursorKeyValue === "")
  ) {
    throw new Error(
      "INKSHADOW_MARKETPLACE_CURSOR_KEY is required when the community marketplace is enabled.",
    );
  }
  const marketplaceCursorKey =
    marketplaceCursorKeyValue === undefined || marketplaceCursorKeyValue === ""
      ? null
      : parseBase64UrlSecret("INKSHADOW_MARKETPLACE_CURSOR_KEY", marketplaceCursorKeyValue);
  const cryptographicKeys = [
    challengeCodeKey,
    challengeHashKey,
    pageCursorKey,
    sessionTokenKey,
    syncCursorKey,
    ...(marketplaceCursorKey === null ? [] : [marketplaceCursorKey]),
    ...(enterpriseResult.enterprise.flowKey === null ? [] : [enterpriseResult.enterprise.flowKey]),
    ...teamInvitationEncryptionKeys,
  ];
  const keyFingerprints = new Set(cryptographicKeys.map((key) => key.toString("hex")));
  if (keyFingerprints.size !== cryptographicKeys.length) {
    throw new Error("InkShadow cloud cryptographic keys must be independently generated.");
  }
  return {
    appEnvironment,
    challengeCodeKey,
    challengeDeliveryEndpoint: deliveryUrl.toString(),
    challengeDeliveryToken,
    challengeHashKey,
    databaseCertificateAuthority: databaseConfiguration.databaseCertificateAuthority,
    databaseMigrationRole: databaseConfiguration.databaseMigrationRole,
    databaseRolesSeparated: databaseConfiguration.databaseRolesSeparated,
    databaseRuntimeRole: databaseConfiguration.databaseRuntimeRole,
    databaseUrl: databaseConfiguration.databaseUrl,
    deletion: loadCloudDeletionConfiguration(environment),
    deploymentMode: enterpriseResult.deploymentMode,
    enterprise: enterpriseResult.enterprise,
    host,
    maintenance: loadCloudMaintenanceConfiguration(environment),
    marketplace: {
      cursorKey: marketplaceCursorKey,
      enabled: marketplaceEnabled,
    },
    minimumClientVersion,
    metricsBearerTokenHash:
      metricsBearerToken === null
        ? null
        : createHash("sha256").update(metricsBearerToken, "utf8").digest(),
    pageCursorKey,
    port,
    requireDatabaseTls: databaseConfiguration.requireDatabaseTls,
    requireHttps,
    sessionTokenKey,
    syncCursorKey,
    teamInvitationDelivery,
    trustedProxies,
  };
}

function parseMetricsBearerToken(
  value: string | undefined,
  requiredInPrivateMode: boolean,
): string | null {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") {
    if (requiredInPrivateMode) {
      throw new Error("INKSHADOW_METRICS_BEARER_TOKEN is required for private deployment.");
    }
    return null;
  }
  if (normalized.length < 32 || normalized.length > 4_096 || /[\r\n]/u.test(normalized)) {
    throw new Error("INKSHADOW_METRICS_BEARER_TOKEN is invalid.");
  }
  return normalized;
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error("INKSHADOW_CLOUD_PORT must be an integer.");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("INKSHADOW_CLOUD_PORT is outside the TCP port range.");
  }
  return port;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "localhost"
  );
}

function parseTrustedProxies(
  value: string | undefined,
  requireHttps: boolean,
): false | readonly string[] {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    return requireHttps ? ["127.0.0.1", "::1"] : false;
  }
  const entries = trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (
    entries.length === 0 ||
    entries.length > 32 ||
    entries.some((entry) => entry.length > 128 || !/^[A-Za-z0-9.:/-]+$/u.test(entry))
  ) {
    throw new Error("INKSHADOW_TRUSTED_PROXY_ADDRESSES is invalid.");
  }
  return entries;
}
