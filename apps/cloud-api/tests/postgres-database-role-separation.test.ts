import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Pool } from "pg";

import {
  assertCloudRuntimeDatabaseSecurity,
  configureCloudDatabaseRoleSeparation,
} from "../src/postgres/database-roles.js";
import { CURRENT_CLOUD_SCHEMA_VERSION, runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";

const adminDatabaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = adminDatabaseUrl === undefined ? describe.skip : describe;

describePostgres("PostgreSQL migration/runtime role separation", () => {
  it("keeps DDL, migration-ledger access and ownership out of the long-lived runtime role", async () => {
    if (adminDatabaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    const suffix = `${String(process.pid)}_${randomBytes(4).toString("hex")}`;
    const databaseName = `inkshadow_role_sep_${suffix}`;
    const runtimeOwnedDatabaseName = `inkshadow_runtime_owned_${suffix}`;
    const migrationRole = `is_migration_${suffix}`;
    const membershipRole = `is_membership_${suffix}`;
    const runtimeRole = `is_runtime_${suffix}`;
    const migrationPassword = randomBytes(24).toString("base64url");
    const runtimePassword = randomBytes(24).toString("base64url");
    const databaseIdentifier = quoteTestIdentifier(databaseName);
    const runtimeOwnedDatabaseIdentifier = quoteTestIdentifier(runtimeOwnedDatabaseName);
    const migrationIdentifier = quoteTestIdentifier(migrationRole);
    const membershipIdentifier = quoteTestIdentifier(membershipRole);
    const runtimeIdentifier = quoteTestIdentifier(runtimeRole);
    const adminPool = createCloudPostgresPool({
      connectionString: adminDatabaseUrl,
      applicationName: "inkshadow-role-separation-admin-test",
      maximumConnections: 1,
      requireTls: false,
    });
    let databaseCreated = false;
    let membershipRoleCreated = false;
    let migrationRoleCreated = false;
    let runtimeOwnedDatabaseCreated = false;
    let runtimeRoleCreated = false;
    let migrationPool: Pool | undefined;
    let runtimePool: Pool | undefined;

    try {
      await adminPool.query(
        `CREATE ROLE ${migrationIdentifier}
             LOGIN
             PASSWORD ${quoteTestLiteral(migrationPassword)}
             NOSUPERUSER
             NOCREATEDB
             NOCREATEROLE
             NOREPLICATION
             BYPASSRLS`,
      );
      migrationRoleCreated = true;
      await adminPool.query(
        `CREATE ROLE ${runtimeIdentifier}
             LOGIN
             PASSWORD ${quoteTestLiteral(runtimePassword)}
             NOSUPERUSER
             NOCREATEDB
             NOCREATEROLE
             NOREPLICATION
             NOBYPASSRLS`,
      );
      runtimeRoleCreated = true;
      await adminPool.query(
        `CREATE ROLE ${membershipIdentifier}
             NOLOGIN
             NOSUPERUSER
             NOCREATEDB
             NOCREATEROLE
             NOREPLICATION
             NOBYPASSRLS`,
      );
      membershipRoleCreated = true;
      await adminPool.query(`CREATE DATABASE ${databaseIdentifier} OWNER ${migrationIdentifier}`);
      databaseCreated = true;

      const migrationUrl = databaseUrlForRole(
        adminDatabaseUrl,
        databaseName,
        migrationRole,
        migrationPassword,
      );
      const runtimeUrl = databaseUrlForRole(
        adminDatabaseUrl,
        databaseName,
        runtimeRole,
        runtimePassword,
      );
      migrationPool = createCloudPostgresPool({
        connectionString: migrationUrl,
        applicationName: "inkshadow-role-separation-migration-test",
        maximumConnections: 1,
        requireTls: false,
      });
      await migrationPool.query(`ALTER SCHEMA public OWNER TO ${migrationIdentifier}`);
      const migrationResult = await runCloudMigrations(migrationPool, undefined, async (client) => {
        await configureCloudDatabaseRoleSeparation(client, {
          migrationRole,
          runtimeRole,
        });
      });
      expect(migrationResult.currentVersion).toBe(CURRENT_CLOUD_SCHEMA_VERSION);
      await migrationPool.end();
      migrationPool = undefined;

      runtimePool = createCloudPostgresPool({
        connectionString: runtimeUrl,
        applicationName: "inkshadow-role-separation-runtime-test",
        maximumConnections: 1,
        requireTls: false,
      });
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).resolves.toBeUndefined();

      await adminPool.query(`GRANT ${runtimeIdentifier} TO ${membershipIdentifier}`);
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("must not be granted to another role");
      await adminPool.query(`REVOKE ${runtimeIdentifier} FROM ${membershipIdentifier}`);
      await adminPool.query(`GRANT ${membershipIdentifier} TO ${runtimeIdentifier}`);
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("must not inherit or assume another role");
      await adminPool.query(`REVOKE ${membershipIdentifier} FROM ${runtimeIdentifier}`);

      await adminPool.query(
        `CREATE DATABASE ${runtimeOwnedDatabaseIdentifier} OWNER ${runtimeIdentifier}`,
      );
      runtimeOwnedDatabaseCreated = true;
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("must not own database objects");
      await adminPool.query(`DROP DATABASE ${runtimeOwnedDatabaseIdentifier}`);
      runtimeOwnedDatabaseCreated = false;

      await expect(runtimePool.query("SELECT count(*) FROM cloud_accounts")).resolves.toMatchObject(
        { rowCount: 1 },
      );
      await expect(
        runtimePool.query("SELECT version FROM cloud_schema_migrations"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtimePool.query(
          `INSERT INTO cloud_schema_migrations (version, description, checksum_sha256)
             VALUES (9999, 'forbidden', $1)`,
          ["0".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtimePool.query("CREATE TABLE runtime_ddl_must_fail (id INTEGER PRIMARY KEY)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtimePool.query("CREATE TEMPORARY TABLE runtime_temp_ddl_must_fail (id INTEGER)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(runCloudMigrations(runtimePool)).rejects.toMatchObject({ code: "42501" });

      migrationPool = createCloudPostgresPool({
        connectionString: migrationUrl,
        applicationName: "inkshadow-role-separation-future-migration-test",
        maximumConnections: 1,
        requireTls: false,
      });

      await migrationPool.query("ALTER TABLE public.cloud_projects DISABLE ROW LEVEL SECURITY");
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("must keep row-level security enabled and forced");
      await migrationPool.query("ALTER TABLE public.cloud_projects ENABLE ROW LEVEL SECURITY");
      await migrationPool.query("ALTER TABLE public.cloud_projects FORCE ROW LEVEL SECURITY");
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).resolves.toBeUndefined();

      await migrationPool.query("ALTER TABLE public.cloud_projects NO FORCE ROW LEVEL SECURITY");
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("must keep row-level security enabled and forced");
      await migrationPool.query("ALTER TABLE public.cloud_projects FORCE ROW LEVEL SECURITY");
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).resolves.toBeUndefined();

      const securityDefinerFunction = "public.inkshadow_has_active_team_membership(UUID, UUID)";
      await migrationPool.query(`ALTER FUNCTION ${securityDefinerFunction} SECURITY INVOKER`);
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("security attributes");
      await migrationPool.query(`ALTER FUNCTION ${securityDefinerFunction} SECURITY DEFINER`);

      await migrationPool.query(`ALTER FUNCTION ${securityDefinerFunction} RESET row_security`);
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("security attributes");
      await migrationPool.query(`ALTER FUNCTION ${securityDefinerFunction} SET row_security = off`);

      await migrationPool.query(
        `ALTER FUNCTION ${securityDefinerFunction} SET search_path = public, pg_catalog`,
      );
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("security attributes");
      await migrationPool.query(
        `ALTER FUNCTION ${securityDefinerFunction} SET search_path = pg_catalog, public`,
      );

      await migrationPool.query(`GRANT EXECUTE ON FUNCTION ${securityDefinerFunction} TO PUBLIC`);
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("PUBLIC must not execute cloud functions");
      await migrationPool.query(
        `REVOKE EXECUTE ON FUNCTION ${securityDefinerFunction} FROM PUBLIC`,
      );

      await migrationPool.query(
        "CREATE TABLE public.cloud_future_migration_fixture (id INTEGER PRIMARY KEY)",
      );
      await expect(
        runtimePool.query("SELECT id FROM cloud_future_migration_fixture"),
      ).rejects.toMatchObject({ code: "42501" });
      const migrationClient = await migrationPool.connect();
      try {
        await expect(
          configureCloudDatabaseRoleSeparation(migrationClient, {
            migrationRole,
            runtimeRole,
          }),
        ).rejects.toThrow("undeclared cloud relation");
      } finally {
        migrationClient.release();
      }
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("undeclared cloud relation");
      await migrationPool.query("DROP TABLE public.cloud_future_migration_fixture");

      await migrationPool.query("CREATE SEQUENCE public.cloud_future_migration_sequence");
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("undeclared cloud sequence");
      const sequenceMigrationClient = await migrationPool.connect();
      try {
        await expect(
          configureCloudDatabaseRoleSeparation(sequenceMigrationClient, {
            migrationRole,
            runtimeRole,
          }),
        ).rejects.toThrow("undeclared cloud sequence");
      } finally {
        sequenceMigrationClient.release();
      }
      await migrationPool.query("DROP SEQUENCE public.cloud_future_migration_sequence");

      await migrationPool.query(
        `CREATE FUNCTION public.cloud_future_migration_function()
         RETURNS INTEGER
         LANGUAGE SQL
         IMMUTABLE
         SECURITY DEFINER
         SET search_path = pg_catalog, public
         SET row_security = off
         AS 'SELECT 1'`,
      );
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("PUBLIC must not execute cloud functions");
      const futureMigrationClient = await migrationPool.connect();
      try {
        await expect(
          configureCloudDatabaseRoleSeparation(futureMigrationClient, {
            migrationRole,
            runtimeRole,
          }),
        ).rejects.toThrow("undeclared cloud function");
      } finally {
        futureMigrationClient.release();
      }
      await expect(
        runtimePool.query("SELECT cloud_future_migration_function()"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).rejects.toThrow("undeclared cloud function");
      await migrationPool.query("DROP FUNCTION public.cloud_future_migration_function()");

      const finalMigrationClient = await migrationPool.connect();
      try {
        await configureCloudDatabaseRoleSeparation(finalMigrationClient, {
          migrationRole,
          runtimeRole,
        });
      } finally {
        finalMigrationClient.release();
      }
      await expect(runtimePool.query("SELECT count(*) FROM cloud_accounts")).resolves.toMatchObject(
        { rowCount: 1 },
      );
      await expect(
        assertCloudRuntimeDatabaseSecurity(runtimePool, {
          migrationRole,
          runtimeRole,
        }),
      ).resolves.toBeUndefined();
    } finally {
      if (runtimePool !== undefined) {
        await runtimePool.end().catch(() => undefined);
      }
      if (migrationPool !== undefined) {
        await migrationPool.end().catch(() => undefined);
      }
      if (databaseCreated) {
        await adminPool
          .query(
            `SELECT pg_terminate_backend(pid)
               FROM pg_stat_activity
               WHERE datname = $1
                 AND pid <> pg_backend_pid()`,
            [databaseName],
          )
          .catch(() => undefined);
        await adminPool.query(`DROP DATABASE ${databaseIdentifier}`).catch(() => undefined);
      }
      if (runtimeOwnedDatabaseCreated) {
        await adminPool
          .query(`DROP DATABASE ${runtimeOwnedDatabaseIdentifier}`)
          .catch(() => undefined);
      }
      if (membershipRoleCreated) {
        await adminPool.query(`DROP ROLE ${membershipIdentifier}`).catch(() => undefined);
      }
      if (runtimeRoleCreated) {
        await adminPool.query(`DROP ROLE ${runtimeIdentifier}`).catch(() => undefined);
      }
      if (migrationRoleCreated) {
        await adminPool.query(`DROP ROLE ${migrationIdentifier}`).catch(() => undefined);
      }
      await adminPool.end();
    }
  }, 120_000);
});

function databaseUrlForRole(
  adminUrl: string,
  databaseName: string,
  role: string,
  password: string,
): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = password;
  return url.toString();
}

function quoteTestIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(identifier)) {
    throw new Error("The generated PostgreSQL test identifier is invalid.");
  }
  return `"${identifier}"`;
}

function quoteTestLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
