import { X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { validateCloudDatabaseRole } from "./database-roles.js";

export type CloudAppEnvironment = "development" | "production" | "test";

export interface CloudRuntimeDatabaseConfiguration {
  readonly appEnvironment: CloudAppEnvironment;
  readonly databaseCertificateAuthority: string | undefined;
  readonly databaseMigrationRole: string;
  readonly databaseRolesSeparated: boolean;
  readonly databaseRuntimeRole: string;
  readonly databaseUrl: string;
  readonly requireDatabaseTls: boolean;
}

export interface CloudMigrationDatabaseConfiguration extends CloudRuntimeDatabaseConfiguration {
  readonly databaseMigrationUrl: string;
}

export function loadCloudRuntimeDatabaseConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): CloudRuntimeDatabaseConfiguration {
  const appEnvironment = parseAppEnvironment(environment.INKSHADOW_APP_ENV);
  const databaseUrl = required(environment, "INKSHADOW_CLOUD_DATABASE_URL");
  const database = parsePostgresUrl(databaseUrl, "INKSHADOW_CLOUD_DATABASE_URL");
  const configuredRuntimeRole = optional(environment.INKSHADOW_CLOUD_RUNTIME_DATABASE_ROLE);
  const configuredMigrationRole = optional(environment.INKSHADOW_CLOUD_MIGRATION_DATABASE_ROLE);
  if (
    appEnvironment === "production" &&
    (configuredRuntimeRole === undefined || configuredMigrationRole === undefined)
  ) {
    throw new Error(
      "INKSHADOW_CLOUD_RUNTIME_DATABASE_ROLE and INKSHADOW_CLOUD_MIGRATION_DATABASE_ROLE are required in production.",
    );
  }
  const databaseRuntimeRole = validateCloudDatabaseRole(
    configuredRuntimeRole ?? decodeDatabaseUsername(database, "INKSHADOW_CLOUD_DATABASE_URL"),
    "INKSHADOW_CLOUD_RUNTIME_DATABASE_ROLE",
  );
  const databaseMigrationRole = validateCloudDatabaseRole(
    configuredMigrationRole ?? databaseRuntimeRole,
    "INKSHADOW_CLOUD_MIGRATION_DATABASE_ROLE",
  );
  assertDatabaseUrlRole(
    database,
    databaseRuntimeRole,
    "INKSHADOW_CLOUD_DATABASE_URL",
    "INKSHADOW_CLOUD_RUNTIME_DATABASE_ROLE",
  );
  const databaseRolesSeparated = databaseRuntimeRole !== databaseMigrationRole;
  if (appEnvironment === "production") {
    if (!databaseRolesSeparated) {
      throw new Error("Production PostgreSQL migration and runtime roles must be distinct.");
    }
    assertProductionDatabaseName(database, "INKSHADOW_CLOUD_DATABASE_URL");
    assertProductionDatabaseTls(database, "INKSHADOW_CLOUD_DATABASE_URL");
  }
  const allowInsecureLocalDatabase = parseBoolean(
    "INKSHADOW_ALLOW_INSECURE_LOCAL_DATABASE",
    environment.INKSHADOW_ALLOW_INSECURE_LOCAL_DATABASE,
    false,
  );
  if (allowInsecureLocalDatabase && !isLoopbackHost(database.hostname)) {
    throw new Error("Insecure PostgreSQL can be enabled only for a loopback database.");
  }
  if (appEnvironment === "production" && allowInsecureLocalDatabase) {
    throw new Error("Production cloud deployments cannot enable insecure local overrides.");
  }
  const databaseCertificateAuthority = loadDatabaseCertificateAuthority(
    environment.INKSHADOW_CLOUD_DATABASE_CA_FILE,
  );
  return {
    appEnvironment,
    databaseCertificateAuthority,
    databaseMigrationRole,
    databaseRolesSeparated,
    databaseRuntimeRole,
    databaseUrl,
    requireDatabaseTls: !allowInsecureLocalDatabase,
  };
}

export function loadCloudMigrationDatabaseConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): CloudMigrationDatabaseConfiguration {
  const runtime = loadCloudRuntimeDatabaseConfiguration(environment);
  const configuredMigrationUrl = optional(environment.INKSHADOW_CLOUD_MIGRATION_DATABASE_URL);
  if (runtime.appEnvironment === "production" && configuredMigrationUrl === undefined) {
    throw new Error("INKSHADOW_CLOUD_MIGRATION_DATABASE_URL is required in production.");
  }
  const databaseMigrationUrl = configuredMigrationUrl ?? runtime.databaseUrl;
  const runtimeDatabase = parsePostgresUrl(runtime.databaseUrl, "INKSHADOW_CLOUD_DATABASE_URL");
  const migrationDatabase = parsePostgresUrl(
    databaseMigrationUrl,
    "INKSHADOW_CLOUD_MIGRATION_DATABASE_URL",
  );
  assertDatabaseUrlRole(
    migrationDatabase,
    runtime.databaseMigrationRole,
    "INKSHADOW_CLOUD_MIGRATION_DATABASE_URL",
    "INKSHADOW_CLOUD_MIGRATION_DATABASE_ROLE",
  );
  if (runtime.appEnvironment === "production") {
    assertProductionDatabaseName(migrationDatabase, "INKSHADOW_CLOUD_MIGRATION_DATABASE_URL");
    assertSameProductionDatabaseTarget(runtimeDatabase, migrationDatabase);
    assertProductionDatabaseTls(migrationDatabase, "INKSHADOW_CLOUD_MIGRATION_DATABASE_URL");
  }
  if (!runtime.requireDatabaseTls && !isLoopbackHost(migrationDatabase.hostname)) {
    throw new Error("Insecure PostgreSQL can be enabled only for a loopback database.");
  }
  return {
    ...runtime,
    databaseMigrationUrl,
  };
}

function parseAppEnvironment(value: string | undefined): CloudAppEnvironment {
  const normalized = value?.trim() ?? "development";
  if (normalized === "development" || normalized === "production" || normalized === "test") {
    return normalized;
  }
  throw new Error("INKSHADOW_APP_ENV must be development, test or production.");
}

function parsePostgresUrl(value: string, name: string): URL {
  let database: URL;
  try {
    database = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL.`);
  }
  if (database.protocol !== "postgres:" && database.protocol !== "postgresql:") {
    throw new Error(`${name} must use PostgreSQL.`);
  }
  if (database.username === "" || database.hostname === "" || database.pathname === "/") {
    throw new Error(`${name} is incomplete.`);
  }
  if (database.hash !== "") {
    throw new Error(`${name} must not contain a URL fragment.`);
  }
  const queryNames = [...new Set(database.searchParams.keys())];
  if (queryNames.some((queryName) => queryName !== "sslmode")) {
    throw new Error(`${name} contains an unsupported PostgreSQL connection parameter.`);
  }
  const sslModes = database.searchParams.getAll("sslmode");
  if (
    sslModes.length > 1 ||
    (sslModes.length === 1 &&
      sslModes[0] !== "require" &&
      sslModes[0] !== "verify-ca" &&
      sslModes[0] !== "verify-full")
  ) {
    throw new Error(`${name} contains an invalid sslmode.`);
  }
  decodeDatabaseName(database, name);
  return database;
}

function assertSameProductionDatabaseTarget(runtime: URL, migration: URL): void {
  if (
    runtime.protocol !== migration.protocol ||
    runtime.hostname !== migration.hostname ||
    effectivePostgresPort(runtime) !== effectivePostgresPort(migration) ||
    assertProductionDatabaseName(runtime, "INKSHADOW_CLOUD_DATABASE_URL") !==
      assertProductionDatabaseName(migration, "INKSHADOW_CLOUD_MIGRATION_DATABASE_URL") ||
    runtime.searchParams.get("sslmode") !== migration.searchParams.get("sslmode")
  ) {
    throw new Error(
      "Production PostgreSQL migration and runtime URLs must use the same protocol, host, effective port, database and TLS mode.",
    );
  }
}

function assertProductionDatabaseName(database: URL, name: string): string {
  if (!/^\/[a-z][a-z0-9_]{0,62}$/u.test(database.pathname)) {
    throw new Error(
      `${name} database name must be an unencoded lowercase PostgreSQL identifier in production.`,
    );
  }
  return database.pathname.slice(1);
}

function assertProductionDatabaseTls(database: URL, name: string): void {
  if (database.searchParams.get("sslmode") !== "verify-full") {
    throw new Error(`${name} must use sslmode=verify-full in production.`);
  }
}

function loadDatabaseCertificateAuthority(value: string | undefined): string | undefined {
  const configuredPath = optional(value);
  if (configuredPath === undefined) {
    return undefined;
  }
  if (
    configuredPath.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(configuredPath) ||
    !path.isAbsolute(configuredPath) ||
    path.normalize(configuredPath) !== configuredPath
  ) {
    throw new Error("INKSHADOW_CLOUD_DATABASE_CA_FILE must be a normalized absolute path.");
  }
  let contents: string;
  try {
    const metadata = statSync(configuredPath);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 65_536) {
      throw new Error("invalid certificate authority file");
    }
    contents = readFileSync(configuredPath, "utf8");
  } catch {
    throw new Error(
      "INKSHADOW_CLOUD_DATABASE_CA_FILE must reference a readable PEM file of at most 64 KiB.",
    );
  }
  const certificates =
    contents.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
  const remainder = certificates.reduce(
    (candidate, certificate) => candidate.replace(certificate, ""),
    contents,
  );
  if (certificates.length < 1 || certificates.length > 16 || remainder.trim() !== "") {
    throw new Error("INKSHADOW_CLOUD_DATABASE_CA_FILE must contain only PEM certificates.");
  }
  try {
    for (const certificate of certificates) {
      new X509Certificate(certificate);
    }
  } catch {
    throw new Error("INKSHADOW_CLOUD_DATABASE_CA_FILE contains an invalid certificate.");
  }
  return contents;
}

function assertDatabaseUrlRole(
  database: URL,
  expectedRole: string,
  urlName: string,
  roleName: string,
): void {
  if (decodeDatabaseUsername(database, urlName) !== expectedRole) {
    throw new Error(`${urlName} username must match ${roleName}.`);
  }
}

function decodeDatabaseUsername(database: URL, name: string): string {
  try {
    return decodeURIComponent(database.username);
  } catch {
    throw new Error(`${name} contains an invalid username.`);
  }
}

function decodeDatabaseName(database: URL, name: string): string {
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(database.pathname.slice(1));
  } catch {
    throw new Error(`${name} contains an invalid database name.`);
  }
  if (
    databaseName === "" ||
    Buffer.byteLength(databaseName, "utf8") > 63 ||
    /[\u0000-\u001f\u007f/\\]/u.test(databaseName)
  ) {
    throw new Error(`${name} contains an invalid database name.`);
  }
  return databaseName;
}

function effectivePostgresPort(database: URL): string {
  return database.port === "" ? "5432" : database.port;
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

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
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
