import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";

import { describe, expect, it } from "vitest";

import {
  loadCloudMigrationDatabaseConfiguration,
  loadCloudRuntimeDatabaseConfiguration,
} from "../src/postgres/configuration.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { parseCloudStartupMode } from "../src/startup-mode.js";

describe("cloud PostgreSQL startup configuration", () => {
  it("keeps the production runtime configuration independent of migration credentials", () => {
    const environment = new Proxy(productionRuntimeEnvironment(), {
      get(target, property, receiver) {
        if (property === "INKSHADOW_CLOUD_MIGRATION_DATABASE_URL") {
          throw new Error("runtime attempted to read migration credentials");
        }
        return Reflect.get(target, property, receiver) as string | undefined;
      },
    });
    expect(loadCloudRuntimeDatabaseConfiguration(environment)).toMatchObject({
      appEnvironment: "production",
      databaseMigrationRole: "inkshadow_migration",
      databaseRolesSeparated: true,
      databaseRuntimeRole: "inkshadow_runtime",
    });
  });

  it("requires migration credentials only for explicit production migration mode", () => {
    expect(() => loadCloudMigrationDatabaseConfiguration(productionRuntimeEnvironment())).toThrow(
      "INKSHADOW_CLOUD_MIGRATION_DATABASE_URL is required in production",
    );
    expect(
      loadCloudMigrationDatabaseConfiguration({
        ...productionRuntimeEnvironment(),
        INKSHADOW_CLOUD_MIGRATION_DATABASE_URL:
          "postgresql://inkshadow_migration@db.example.test/inkshadow_cloud?sslmode=verify-full",
      }),
    ).toMatchObject({
      databaseMigrationRole: "inkshadow_migration",
      databaseMigrationUrl:
        "postgresql://inkshadow_migration@db.example.test/inkshadow_cloud?sslmode=verify-full",
      databaseRuntimeRole: "inkshadow_runtime",
    });
  });

  it("accepts only unencoded lowercase production database names", () => {
    for (const databasePath of ["db:name", "db%3Aname"]) {
      expect(() =>
        loadCloudRuntimeDatabaseConfiguration({
          ...productionRuntimeEnvironment(),
          INKSHADOW_CLOUD_DATABASE_URL: `postgresql://inkshadow_runtime@db.example.test/${databasePath}?sslmode=verify-full`,
        }),
      ).toThrow("unencoded lowercase PostgreSQL identifier");
    }
    expect(
      loadCloudRuntimeDatabaseConfiguration(productionRuntimeEnvironment()).databaseUrl,
    ).toContain("/inkshadow_cloud?");
  });

  it("binds migration and runtime to one strict verify-full target", () => {
    const valid = {
      ...productionRuntimeEnvironment(),
      INKSHADOW_CLOUD_MIGRATION_DATABASE_URL:
        "postgresql://inkshadow_migration@db.example.test/inkshadow_cloud?sslmode=verify-full",
    };
    for (const migrationUrl of [
      "postgres://inkshadow_migration@db.example.test/inkshadow_cloud?sslmode=verify-full",
      "postgresql://inkshadow_migration@other.example.test/inkshadow_cloud?sslmode=verify-full",
      "postgresql://inkshadow_migration@db.example.test:5433/inkshadow_cloud?sslmode=verify-full",
      "postgresql://inkshadow_migration@db.example.test/another_database?sslmode=verify-full",
    ]) {
      expect(() =>
        loadCloudMigrationDatabaseConfiguration({
          ...valid,
          INKSHADOW_CLOUD_MIGRATION_DATABASE_URL: migrationUrl,
        }),
      ).toThrow("same protocol, host, effective port, database and TLS mode");
    }
    expect(() =>
      loadCloudRuntimeDatabaseConfiguration({
        ...productionRuntimeEnvironment(),
        INKSHADOW_CLOUD_DATABASE_URL:
          "postgresql://inkshadow_runtime@db.example.test/inkshadow_cloud?sslmode=require",
      }),
    ).toThrow("sslmode=verify-full");
    expect(() =>
      loadCloudMigrationDatabaseConfiguration({
        ...valid,
        INKSHADOW_CLOUD_MIGRATION_DATABASE_URL:
          "postgresql://inkshadow_migration@db.example.test/inkshadow_cloud?options=-c%20search_path%3Devil",
      }),
    ).toThrow("unsupported PostgreSQL connection parameter");
    expect(() =>
      loadCloudMigrationDatabaseConfiguration({
        ...valid,
        INKSHADOW_CLOUD_MIGRATION_DATABASE_URL:
          "postgresql://inkshadow_migration@db.example.test/inkshadow_cloud?sslmode=verify-full#shadow",
      }),
    ).toThrow("must not contain a URL fragment");
  });

  it("rejects unsafe CA paths and unknown startup arguments", () => {
    expect(() =>
      loadCloudRuntimeDatabaseConfiguration({
        ...productionRuntimeEnvironment(),
        INKSHADOW_CLOUD_DATABASE_CA_FILE: "relative/ca.pem",
      }),
    ).toThrow("normalized absolute path");
    expect(parseCloudStartupMode([])).toBe("runtime");
    expect(parseCloudStartupMode(["--migrate-only"])).toBe("migrate-only");
    expect(() => parseCloudStartupMode(["--migrate-only", "--serve"])).toThrow("accepts only");
  });

  it("removes sslmode before applying structured certificate verification", async () => {
    const certificateAuthority =
      "-----BEGIN CERTIFICATE-----\nTEST-CA\n-----END CERTIFICATE-----\n";
    const pool = createCloudPostgresPool({
      certificateAuthority,
      connectionString:
        "postgresql://inkshadow_runtime@db.example.test/inkshadow_cloud?sslmode=verify-full",
      requireTls: true,
    });
    try {
      expect(pool.options.connectionString).not.toContain("sslmode");
      expect(pool.options.ssl).toEqual({
        ca: certificateAuthority,
        rejectUnauthorized: true,
      });
    } finally {
      await pool.end();
    }
  });

  it("loads a bounded valid private CA bundle from an absolute file", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "inkshadow-database-ca-"));
    try {
      const caFile = path.join(temporary, "ca.pem");
      await writeFile(caFile, `${rootCertificates[0] ?? ""}\n`, "utf8");
      expect(
        loadCloudRuntimeDatabaseConfiguration({
          ...productionRuntimeEnvironment(),
          INKSHADOW_CLOUD_DATABASE_CA_FILE: caFile,
        }).databaseCertificateAuthority,
      ).toContain("BEGIN CERTIFICATE");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });
});

function productionRuntimeEnvironment(): Readonly<Record<string, string>> {
  return {
    INKSHADOW_ALLOW_INSECURE_LOCAL_DATABASE: "false",
    INKSHADOW_APP_ENV: "production",
    INKSHADOW_CLOUD_DATABASE_URL:
      "postgresql://inkshadow_runtime@db.example.test/inkshadow_cloud?sslmode=verify-full",
    INKSHADOW_CLOUD_MIGRATION_DATABASE_ROLE: "inkshadow_migration",
    INKSHADOW_CLOUD_RUNTIME_DATABASE_ROLE: "inkshadow_runtime",
  };
}
