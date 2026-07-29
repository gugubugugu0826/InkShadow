import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Pool } from "pg";

import { defaultCloudMigrationsDirectory, runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { PostgresFixedWindowRateLimiter } from "../src/postgres/rate-limiter.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("PostgreSQL cloud foundation migration", () => {
  let pool: Pool;

  beforeAll(() => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      connectionString: databaseUrl,
      applicationName: "inkshadow-cloud-migration-test",
      maximumConnections: 2,
      requireTls: false,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies once, verifies checksums and keeps private project data ciphertext-only", async () => {
    const first = await runCloudMigrations(pool);
    const second = await runCloudMigrations(pool);

    expect(first.currentVersion).toBe(16);
    expect(first.appliedVersions).toEqual(
      Array.from(
        { length: first.appliedVersions.length },
        (_, index) => first.currentVersion + 1 - first.appliedVersions.length + index,
      ),
    );
    expect(second).toEqual({ appliedVersions: [], currentVersion: 16 });

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "cloud_accounts",
      "cloud_ai_project_budgets",
      "cloud_ai_project_usage_months",
      "cloud_ai_team_budgets",
      "cloud_ai_team_usage_months",
      "cloud_ai_usage_events",
      "cloud_ai_usage_idempotency",
      "cloud_ai_usage_reservations",
      "cloud_audit_events",
      "cloud_deletion_job_projects",
      "cloud_deletion_jobs",
      "cloud_deletion_markers",
      "cloud_enterprise_oidc_bindings",
      "cloud_enterprise_oidc_flows",
      "cloud_enterprise_policies",
      "cloud_idempotency_records",
      "cloud_marketplace_appeals",
      "cloud_marketplace_artifacts",
      "cloud_marketplace_download_audits",
      "cloud_marketplace_idempotency",
      "cloud_marketplace_moderation_events",
      "cloud_marketplace_reports",
      "cloud_marketplace_version_bodies",
      "cloud_marketplace_versions",
      "cloud_project_access",
      "cloud_project_assignments",
      "cloud_projects",
      "cloud_rate_limit_windows",
      "cloud_retention_holds",
      "cloud_review_submissions",
      "cloud_review_thread_items",
      "cloud_review_threads",
      "cloud_schema_migrations",
      "cloud_sessions",
      "cloud_sync_batches",
      "cloud_team_audit_events",
      "cloud_team_invitation_outbox",
      "cloud_team_invitations",
      "cloud_team_memberships",
      "cloud_team_project_key_envelopes",
      "cloud_team_template_applications",
      "cloud_team_template_versions",
      "cloud_team_templates",
      "cloud_teams",
      "device_project_key_envelopes",
      "identity_challenges",
      "project_key_versions",
      "registered_devices",
      "sync_ciphertext_chunks",
      "sync_operations",
      "sync_tombstone_acknowledgements",
      "sync_tombstones",
    ]);
    const deletionRls = await pool.query<{
      relforcerowsecurity: boolean;
      relname: string;
      relrowsecurity: boolean;
    }>(
      `SELECT relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
       FROM pg_class AS relation
       WHERE relation.relname = ANY($1::text[])
       ORDER BY relation.relname`,
      [
        [
          "cloud_deletion_job_projects",
          "cloud_deletion_jobs",
          "cloud_deletion_markers",
          "cloud_retention_holds",
          "cloud_enterprise_oidc_bindings",
          "cloud_enterprise_oidc_flows",
          "cloud_enterprise_policies",
        ],
      ],
    );
    expect(deletionRls.rows).toEqual([
      {
        relforcerowsecurity: true,
        relname: "cloud_deletion_job_projects",
        relrowsecurity: true,
      },
      {
        relforcerowsecurity: true,
        relname: "cloud_deletion_jobs",
        relrowsecurity: true,
      },
      {
        relforcerowsecurity: true,
        relname: "cloud_deletion_markers",
        relrowsecurity: true,
      },
      {
        relforcerowsecurity: true,
        relname: "cloud_enterprise_oidc_bindings",
        relrowsecurity: true,
      },
      {
        relforcerowsecurity: true,
        relname: "cloud_enterprise_oidc_flows",
        relrowsecurity: true,
      },
      {
        relforcerowsecurity: true,
        relname: "cloud_enterprise_policies",
        relrowsecurity: true,
      },
      {
        relforcerowsecurity: true,
        relname: "cloud_retention_holds",
        relrowsecurity: true,
      },
    ]);

    const forbiddenColumns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name = ANY($1::text[])
       ORDER BY table_name, column_name`,
      [
        [
          "access_token",
          "body",
          "content",
          "password",
          "plaintext",
          "private_key",
          "prompt",
          "raw_project_data_key",
          "recovery_code",
          "refresh_token",
        ],
      ],
    );
    expect(forbiddenColumns.rows).toEqual([
      {
        column_name: "content",
        table_name: "cloud_marketplace_version_bodies",
      },
    ]);

    const responseSnapshotColumn = await pool.query<{
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cloud_idempotency_records'
         AND column_name = 'response_snapshot'`,
    );
    expect(responseSnapshotColumn.rows).toEqual([
      {
        data_type: "jsonb",
        is_nullable: "YES",
      },
    ]);
    const projectSnapshotColumns = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'cloud_projects' AND column_name = 'sync_compaction_epoch')
           OR (
             table_name = 'project_key_versions'
             AND column_name IN ('publication_request_sha256', 'publication_published_at')
           )
         )
       ORDER BY column_name`,
    );
    expect(projectSnapshotColumns.rows).toEqual([
      {
        column_name: "publication_published_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      },
      {
        column_name: "publication_request_sha256",
        data_type: "character",
        is_nullable: "YES",
      },
      {
        column_name: "sync_compaction_epoch",
        data_type: "bigint",
        is_nullable: "NO",
      },
    ]);
    const syncObjectTypeColumns = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      table_name: string;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
         AND column_name = 'object_type'
       ORDER BY table_name`,
      [["sync_operations", "sync_tombstone_acknowledgements", "sync_tombstones"]],
    );
    expect(syncObjectTypeColumns.rows).toEqual([
      {
        table_name: "sync_operations",
        column_name: "object_type",
        data_type: "text",
        is_nullable: "NO",
      },
      {
        table_name: "sync_tombstone_acknowledgements",
        column_name: "object_type",
        data_type: "text",
        is_nullable: "NO",
      },
      {
        table_name: "sync_tombstones",
        column_name: "object_type",
        data_type: "text",
        is_nullable: "NO",
      },
    ]);
    const syncObjectTypeChecks = await pool.query<{
      constraint_definition: string;
      table_name: string;
    }>(
      `SELECT
         relation.relname AS table_name,
         pg_get_constraintdef(constraint_row.oid) AS constraint_definition
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS relation
         ON relation.oid = constraint_row.conrelid
       WHERE constraint_row.conname = ANY($1::text[])
       ORDER BY relation.relname`,
      [
        [
          "sync_ciphertext_chunks_object_type_check",
          "sync_operations_object_type_check",
          "sync_tombstone_acknowledgements_object_type_check",
          "sync_tombstones_object_type_check",
        ],
      ],
    );
    expect(syncObjectTypeChecks.rows.map((row) => row.table_name)).toEqual([
      "sync_ciphertext_chunks",
      "sync_operations",
      "sync_tombstone_acknowledgements",
      "sync_tombstones",
    ]);
    expect(
      syncObjectTypeChecks.rows.every((row) =>
        row.constraint_definition.includes("project_manifest"),
      ),
    ).toBe(true);
    const portableSequenceChecks = await pool.query<{
      constraint_definition: string;
      constraint_name: string;
    }>(
      `SELECT
         constraint_row.conname AS constraint_name,
         pg_get_constraintdef(constraint_row.oid) AS constraint_definition
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS relation
         ON relation.oid = constraint_row.conrelid
       WHERE relation.relname = 'sync_operations'
         AND constraint_row.conname = 'sync_operations_device_sequence_portable_check'`,
    );
    expect(portableSequenceChecks.rows).toHaveLength(1);
    expect(portableSequenceChecks.rows[0]?.constraint_definition).toBe(
      "CHECK ((device_sequence <= '9007199254740991'::bigint))",
    );
    const typedSyncConstraints = await pool.query<{
      constraint_name: string;
      constraint_type: string;
    }>(
      `SELECT conname AS constraint_name, contype::text AS constraint_type
       FROM pg_constraint
       WHERE conname = ANY($1::text[])
       ORDER BY conname`,
      [
        [
          "sync_chunks_typed_operation_identity_fk",
          "sync_operations_typed_chunk_identity_unique",
          "sync_operations_typed_tombstone_identity_unique",
          "sync_tombstone_acknowledgements_typed_tombstone_fk",
          "sync_tombstones_typed_operation_identity_fk",
        ],
      ],
    );
    expect(typedSyncConstraints.rows).toEqual([
      {
        constraint_name: "sync_chunks_typed_operation_identity_fk",
        constraint_type: "f",
      },
      {
        constraint_name: "sync_operations_typed_chunk_identity_unique",
        constraint_type: "u",
      },
      {
        constraint_name: "sync_operations_typed_tombstone_identity_unique",
        constraint_type: "u",
      },
      {
        constraint_name: "sync_tombstone_acknowledgements_typed_tombstone_fk",
        constraint_type: "f",
      },
      {
        constraint_name: "sync_tombstones_typed_operation_identity_fk",
        constraint_type: "f",
      },
    ]);
    const tombstonePrimaryKeys = await pool.query<{
      constraint_definition: string;
      table_name: string;
    }>(
      `SELECT
         relation.relname AS table_name,
         pg_get_constraintdef(constraint_row.oid) AS constraint_definition
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS relation
         ON relation.oid = constraint_row.conrelid
       WHERE constraint_row.conname = ANY($1::text[])
       ORDER BY relation.relname`,
      [["sync_tombstone_acknowledgements_pkey", "sync_tombstones_pkey"]],
    );
    expect(tombstonePrimaryKeys.rows).toEqual([
      {
        table_name: "sync_tombstone_acknowledgements",
        constraint_definition:
          "PRIMARY KEY (tenant_id, project_id, object_type, object_id, object_generation, device_id)",
      },
      {
        table_name: "sync_tombstones",
        constraint_definition:
          "PRIMARY KEY (tenant_id, project_id, object_type, object_id, object_generation)",
      },
    ]);

    const rowSecurity = await pool.query<{
      relname: string;
      relforcerowsecurity: boolean;
      relrowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = ANY($1::text[])
       ORDER BY relname`,
      [
        [
          "cloud_project_access",
          "cloud_projects",
          "cloud_sync_batches",
          "device_project_key_envelopes",
          "project_key_versions",
          "sync_ciphertext_chunks",
          "sync_operations",
          "sync_tombstone_acknowledgements",
          "sync_tombstones",
        ],
      ],
    );
    expect(rowSecurity.rows).toHaveLength(9);
    expect(rowSecurity.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(
      true,
    );

    const rlsHelpers = await pool.query<{
      function_name: string;
      is_security_definer: boolean;
      public_execute_revoked: boolean;
      runtime_execute_granted: boolean;
      settings: readonly string[] | null;
    }>(
      `SELECT
         procedure.proname AS function_name,
         procedure.prosecdef AS is_security_definer,
         NOT EXISTS (
           SELECT 1
           FROM aclexplode(
             COALESCE(
               procedure.proacl,
               acldefault('f', procedure.proowner)
             )
           ) AS privilege
           WHERE privilege.grantee = 0
             AND privilege.privilege_type = 'EXECUTE'
         ) AS public_execute_revoked,
         has_function_privilege(
           current_user,
           procedure.oid,
           'EXECUTE'
         ) AS runtime_execute_granted,
         procedure.proconfig AS settings
       FROM pg_proc AS procedure
       JOIN pg_namespace AS namespace
         ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure.proname = ANY($1::text[])
       ORDER BY procedure.proname`,
      [
        [
          "inkshadow_has_active_review_assignment",
          "inkshadow_has_active_team_membership",
          "inkshadow_invitation_matches_current_account",
          "inkshadow_team_has_active_project_assignment",
        ],
      ],
    );
    expect(rlsHelpers.rows).toEqual([
      {
        function_name: "inkshadow_has_active_review_assignment",
        is_security_definer: true,
        public_execute_revoked: true,
        runtime_execute_granted: true,
        settings: ["search_path=pg_catalog, public", "row_security=off"],
      },
      {
        function_name: "inkshadow_has_active_team_membership",
        is_security_definer: true,
        public_execute_revoked: true,
        runtime_execute_granted: true,
        settings: ["search_path=pg_catalog, public", "row_security=off"],
      },
      {
        function_name: "inkshadow_invitation_matches_current_account",
        is_security_definer: true,
        public_execute_revoked: true,
        runtime_execute_granted: true,
        settings: ["search_path=pg_catalog, public", "row_security=off"],
      },
      {
        function_name: "inkshadow_team_has_active_project_assignment",
        is_security_definer: true,
        public_execute_revoked: true,
        runtime_execute_granted: true,
        settings: ["search_path=pg_catalog, public", "row_security=off"],
      },
    ]);
  });

  it("rejects credential-bearing or unscoped idempotency snapshots at the database boundary", async () => {
    const uuid = createMonotonicUuidV7Factory();
    const tenantId = uuid();
    const deletionRequestId = uuid();
    const now = new Date("2026-07-27T12:44:00.000Z");
    const client = await pool.connect();
    const insertSnapshot = (
      scopeCharacter: string,
      resultKind: "accepted" | "deletion_job" | "session",
      snapshot: unknown,
    ) =>
      client.query(
        `INSERT INTO cloud_idempotency_records (
           scope_hash_sha256,
           actor_account_id,
           operation_id,
           idempotency_key_hash_sha256,
           request_hash_sha256,
           result_kind,
           result_resource_id,
           result_digest_sha256,
           response_status,
           response_snapshot,
           created_at,
           expires_at
         ) VALUES (
           $1,
           NULL,
           'migration.snapshot-boundary-test',
           $2,
           $3,
           $4,
           $5,
           $6,
           200,
           $7::jsonb,
           $8,
           $9
         )`,
        [
          scopeCharacter.repeat(64),
          "b".repeat(64),
          "c".repeat(64),
          resultKind,
          deletionRequestId,
          "d".repeat(64),
          JSON.stringify(snapshot),
          now,
          new Date(now.getTime() + 60_000),
        ],
      );

    try {
      await client.query("BEGIN");
      await expect(
        insertSnapshot("e", "accepted", {
          accepted: true,
          nested: Object.fromEntries([
            [["pass", "word"].join(""), "credential-field-constraint-sentinel"],
          ]),
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "cloud_idempotency_response_snapshot_secret_free_check",
      });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await expect(
        insertSnapshot("f", "deletion_job", {
          response: {},
          snapshotKind: "deletion_job_v1",
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "cloud_idempotency_deletion_snapshot_scope_check",
      });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await expect(
        insertSnapshot("8", "session", {
          grant: {},
          snapshotKind: "session_grant_v1",
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "cloud_idempotency_session_snapshot_secret_free_check",
      });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await expect(
        insertSnapshot("9", "deletion_job", {
          response: {},
          snapshotKind: "deletion_job_v1",
          tenantId,
        }),
      ).resolves.toMatchObject({ rowCount: 1 });
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("accepts the portable device-sequence ceiling and rejects the next bigint", async () => {
    const uuid = createMonotonicUuidV7Factory();
    const accountId = uuid();
    const deviceId = uuid();
    const projectId = uuid();
    const objectId = uuid();
    const now = new Date("2026-07-27T12:45:00.000Z");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO cloud_accounts (
           account_id,
           email_canonical,
           password_hash,
           state,
           verified_at,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, 'active', $4, $4, $4)`,
        [
          accountId,
          `portable-sequence-${accountId}@example.test`,
          `scrypt-test-${"x".repeat(32)}`,
          now,
        ],
      );
      await client.query(
        `INSERT INTO registered_devices (
           device_id,
           account_id,
           display_name,
           algorithm,
           public_key,
           public_key_fingerprint,
           client_version,
           state,
           created_at,
           updated_at
         ) VALUES (
           $1,
           $2,
           'Portable sequence test',
           'DHKEM-P256-HKDF-SHA256',
           $3,
           $4,
           '0.1.0',
           'trusted',
           $5,
           $5
         )`,
        [deviceId, accountId, "A".repeat(87), "a".repeat(64), now],
      );
      await client.query(
        `INSERT INTO cloud_projects (
           tenant_id,
           project_id,
           owner_account_id,
           state,
           created_at,
           updated_at
         ) VALUES ($1, $2, $1, 'active', $3, $3)`,
        [accountId, projectId, now],
      );
      await client.query(
        `INSERT INTO sync_operations (
           tenant_id,
           project_id,
           operation_id,
           device_id,
           device_sequence,
           object_type,
           object_id,
           object_generation,
           kind,
           version_vector,
           encrypted_chunk_ids,
           created_at
         ) VALUES (
           $1,
           $2,
           $3,
           $4,
           9007199254740991,
           'chapter_version',
           $5,
           1,
           'delete',
           $7::jsonb,
           ARRAY[]::uuid[],
           $6
         )`,
        [
          accountId,
          projectId,
          uuid(),
          deviceId,
          objectId,
          now,
          JSON.stringify({ [deviceId]: Number.MAX_SAFE_INTEGER }),
        ],
      );
      await expect(
        client.query(
          `INSERT INTO sync_operations (
             tenant_id,
             project_id,
             operation_id,
             device_id,
             device_sequence,
             object_type,
             object_id,
             object_generation,
             kind,
             version_vector,
             encrypted_chunk_ids,
             created_at
           ) VALUES (
             $1,
             $2,
             $3,
             $4,
             9007199254740992,
             'chapter_version',
             $5,
             1,
             'delete',
             $7::jsonb,
             ARRAY[]::uuid[],
             $6
           )`,
          [
            accountId,
            projectId,
            uuid(),
            deviceId,
            uuid(),
            now,
            JSON.stringify({ [deviceId]: Number.MAX_SAFE_INTEGER + 1 }),
          ],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "sync_operations_device_sequence_portable_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => {
        // A failed constraint leaves the transaction aborted until rollback.
      });
      client.release();
    }
  });

  it("fails closed instead of inferring object types for a non-empty v1 sync ledger", async () => {
    const schemaName = `sync_v2_cutover_${createMonotonicUuidV7Factory()().replaceAll("-", "")}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schemaName}"`);
      await client.query(`
        CREATE TABLE sync_operations (legacy_marker INTEGER NOT NULL);
        CREATE TABLE sync_ciphertext_chunks (legacy_marker INTEGER NOT NULL);
        CREATE TABLE sync_tombstones (legacy_marker INTEGER NOT NULL);
        CREATE TABLE sync_tombstone_acknowledgements (legacy_marker INTEGER NOT NULL);
        CREATE TABLE cloud_sync_batches (legacy_marker INTEGER NOT NULL);
        INSERT INTO sync_operations (legacy_marker) VALUES (1)
      `);
      const migrationSql = await readFile(
        path.join(defaultCloudMigrationsDirectory(), "0006_sync_protocol_v2_object_types.sql"),
        "utf8",
      );
      await expect(client.query(migrationSql)).rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK");

      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name IN ('sync_operations', 'sync_tombstones')
           AND column_name = 'object_type'`,
        [schemaName],
      );
      expect(columns.rows).toEqual([]);
    } finally {
      await client.query("ROLLBACK").catch(() => {
        // The transaction may already have been rolled back by the assertion path.
      });
      await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      client.release();
    }
  });

  it("enforces append-only audit records in the database", async () => {
    const uuid = createMonotonicUuidV7Factory();
    const eventId = uuid();
    const requestId = uuid();
    await pool.query(
      `INSERT INTO cloud_audit_events (
         event_id,
         request_id,
         resource_type,
         action,
         result,
         redacted_diff,
         created_at
       ) VALUES ($1, $2, 'migration_test', 'insert', 'allowed', '{}', now())`,
      [eventId, requestId],
    );

    await expect(
      pool.query(
        `UPDATE cloud_audit_events
         SET action = 'tampered'
         WHERE event_id = $1`,
        [eventId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query("DELETE FROM cloud_audit_events WHERE event_id = $1", [eventId]),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("enforces shared rate-limit windows atomically in PostgreSQL", async () => {
    const limiter = new PostgresFixedWindowRateLimiter(pool);
    const key = `postgres-rate-limit:${createMonotonicUuidV7Factory()()}`;
    const now = new Date("2026-07-27T13:00:00.000Z");

    await expect(limiter.consume({ key, limit: 1, now, windowMs: 60_000 })).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    await expect(limiter.consume({ key, limit: 1, now, windowMs: 60_000 })).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    await expect(
      limiter.consume({
        key,
        limit: 1,
        now: new Date(now.getTime() + 60_000),
        windowMs: 60_000,
      }),
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("isolates tenant rows for the non-superuser application role", async () => {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'inkshadow_rls_test'
        ) THEN
          CREATE ROLE inkshadow_rls_test LOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$
    `);
    await pool.query("ALTER ROLE inkshadow_rls_test LOGIN NOSUPERUSER NOBYPASSRLS");
    await pool.query("GRANT USAGE ON SCHEMA public TO inkshadow_rls_test");
    await pool.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO inkshadow_rls_test",
    );
    await pool.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO inkshadow_rls_test");

    const uuid = createMonotonicUuidV7Factory();
    const firstTenant = uuid();
    const secondTenant = uuid();
    const firstProject = uuid();
    const secondProject = uuid();
    const firstHold = uuid();
    const secondHold = uuid();
    const now = new Date("2026-07-27T13:30:00.000Z");
    for (const accountId of [firstTenant, secondTenant]) {
      await pool.query(
        `INSERT INTO cloud_accounts (
           account_id,
           email_canonical,
           password_hash,
           state,
           verified_at,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, 'active', $4, $4, $4)`,
        [accountId, `rls-${accountId}@example.test`, `scrypt-test-${"x".repeat(32)}`, now],
      );
    }
    await pool.query(
      `INSERT INTO cloud_projects (
         tenant_id,
         project_id,
         owner_account_id,
         state,
         revision,
         created_at,
         updated_at
       ) VALUES
         ($1, $2, $1, 'active', 1, $5, $5),
         ($3, $4, $3, 'active', 1, $5, $5)`,
      [firstTenant, firstProject, secondTenant, secondProject, now],
    );
    await pool.query(
      `INSERT INTO cloud_retention_holds (
         tenant_id,
         hold_id,
         target_kind,
         target_id,
         reason,
         placed_at
       ) VALUES
         ($1, $2, 'project', $3, 'legal_hold_active', $7),
         ($4, $5, 'project', $6, 'legal_hold_active', $7)`,
      [firstTenant, firstHold, firstProject, secondTenant, secondHold, secondProject, now],
    );

    const limitedUrl = new URL(databaseUrl ?? "");
    limitedUrl.username = "inkshadow_rls_test";
    limitedUrl.password = "";
    const limitedPool = createCloudPostgresPool({
      connectionString: limitedUrl.toString(),
      applicationName: "inkshadow-cloud-rls-test",
      maximumConnections: 1,
      requireTls: false,
    });
    const client = await limitedPool.connect();
    try {
      const role = await client.query<{
        rolbypassrls: boolean;
        rolsuper: boolean;
      }>(
        `SELECT rolsuper, rolbypassrls
         FROM pg_roles
         WHERE rolname = current_user`,
      );
      expect(role.rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
      });
      expect(
        (await client.query("SELECT project_id FROM cloud_projects ORDER BY project_id")).rows,
      ).toEqual([]);
      expect(
        (await client.query("SELECT hold_id FROM cloud_retention_holds ORDER BY hold_id")).rows,
      ).toEqual([]);

      await client.query("BEGIN");
      await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [firstTenant]);
      const visible = await client.query<{ project_id: string }>(
        "SELECT project_id FROM cloud_projects ORDER BY project_id",
      );
      expect(visible.rows).toEqual([{ project_id: firstProject }]);
      expect(
        (await client.query("SELECT hold_id FROM cloud_retention_holds ORDER BY hold_id")).rows,
      ).toEqual([{ hold_id: firstHold }]);
      const crossTenantUpdate = await client.query(
        `UPDATE cloud_projects
         SET revision = revision + 1
         WHERE tenant_id = $1
           AND project_id = $2`,
        [secondTenant, secondProject],
      );
      expect(crossTenantUpdate.rowCount).toBe(0);
      const crossTenantHoldUpdate = await client.query(
        `UPDATE cloud_retention_holds
         SET released_at = $3
         WHERE tenant_id = $1
           AND hold_id = $2`,
        [secondTenant, secondHold, now],
      );
      expect(crossTenantHoldUpdate.rowCount).toBe(0);
      await expect(
        client.query(
          `INSERT INTO cloud_projects (
             tenant_id,
             project_id,
             owner_account_id,
             state,
             revision,
             created_at,
             updated_at
           ) VALUES ($1, $2, $1, 'active', 1, $3, $3)`,
          [secondTenant, uuid(), now],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await limitedPool.end();
    }
  });
});
