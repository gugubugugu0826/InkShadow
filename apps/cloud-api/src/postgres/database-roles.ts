import type { Pool, PoolClient } from "pg";

export interface CloudDatabaseRoles {
  readonly migrationRole: string;
  readonly runtimeRole: string;
}

interface DatabaseIdentityRow {
  readonly database_name: string;
  readonly database_owner: string;
  readonly session_role: string;
}

interface RoleCapabilityRow {
  readonly rolbypassrls: boolean;
  readonly rolcanlogin: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolinherit: boolean;
  readonly rolname: string;
  readonly rolreplication: boolean;
  readonly rolsuper: boolean;
}

interface SchemaOwnerRow {
  readonly schema_owner: string;
}

interface BooleanRow {
  readonly value: boolean;
}

interface CountRow {
  readonly count: string;
}

interface TableAccessRow {
  readonly force_row_security: boolean;
  readonly object_name: string;
  readonly owner_name: string;
  readonly public_has_privilege: boolean;
  readonly row_security: boolean;
  readonly runtime_delete: boolean;
  readonly runtime_insert: boolean;
  readonly runtime_references: boolean;
  readonly runtime_select: boolean;
  readonly runtime_trigger: boolean;
  readonly runtime_truncate: boolean;
  readonly runtime_update: boolean;
}

interface FunctionAccessRow {
  readonly configuration: readonly string[] | null;
  readonly function_identity: string;
  readonly owner_name: string;
  readonly public_execute: boolean;
  readonly runtime_execute: boolean;
  readonly security_definer: boolean;
}

interface SequenceAccessRow {
  readonly object_name: string;
  readonly owner_name: string;
  readonly public_has_privilege: boolean;
  readonly runtime_select: boolean;
  readonly runtime_update: boolean;
  readonly runtime_usage: boolean;
}

const POSTGRES_ROLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
export const CLOUD_RUNTIME_TABLES = Object.freeze([
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
] as const);

export const CLOUD_FORCE_RLS_TABLES = Object.freeze([
  "cloud_ai_project_budgets",
  "cloud_ai_project_usage_months",
  "cloud_ai_team_budgets",
  "cloud_ai_team_usage_months",
  "cloud_ai_usage_events",
  "cloud_ai_usage_idempotency",
  "cloud_ai_usage_reservations",
  "cloud_deletion_job_projects",
  "cloud_deletion_jobs",
  "cloud_deletion_markers",
  "cloud_enterprise_oidc_bindings",
  "cloud_enterprise_oidc_flows",
  "cloud_enterprise_policies",
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
  "cloud_retention_holds",
  "cloud_review_submissions",
  "cloud_review_thread_items",
  "cloud_review_threads",
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
  "project_key_versions",
  "sync_ciphertext_chunks",
  "sync_operations",
  "sync_tombstone_acknowledgements",
  "sync_tombstones",
] as const);

export const CLOUD_RUNTIME_SEQUENCES = Object.freeze([
  "sync_operations_remote_sequence_seq",
] as const);

export const CLOUD_RUNTIME_FUNCTIONS = Object.freeze([
  "enforce_cloud_account_team_ownership()",
  "enforce_cloud_review_submission_immutability()",
  "enforce_cloud_review_thread_item_immutability()",
  "enforce_cloud_review_thread_transition()",
  "enforce_cloud_team_active_owner()",
  "enforce_cloud_team_project_key_envelope_immutability()",
  "enforce_cloud_team_template_transition()",
  "inkshadow_account_has_active_team_access(UUID)",
  "inkshadow_account_requires_ownership_transfer(UUID)",
  "inkshadow_active_team_project_key_envelope_exists(UUID, UUID, UUID, INTEGER, UUID)",
  "inkshadow_all_text_array_values_match(TEXT[], TEXT, INTEGER, BOOLEAN)",
  "inkshadow_cancel_team_invitation_outbox(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT)",
  "inkshadow_claim_team_invitation_outbox(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)",
  "inkshadow_count_review_ciphertexts(UUID, UUID)",
  "inkshadow_count_review_records(UUID, UUID)",
  "inkshadow_count_team_project_key_envelopes(UUID, UUID)",
  "inkshadow_current_account()",
  "inkshadow_current_device()",
  "inkshadow_current_team()",
  "inkshadow_current_tenant()",
  "inkshadow_enterprise_public_sso_policy(UUID)",
  "inkshadow_enterprise_required_sso_teams(UUID)",
  "inkshadow_enterprise_resolve_flow(UUID)",
  "inkshadow_enterprise_resolve_member(UUID, TEXT)",
  "inkshadow_has_active_review_assignment(UUID, UUID, UUID)",
  "inkshadow_has_active_team_membership(UUID, UUID)",
  "inkshadow_has_active_team_template_assignment(UUID, UUID, UUID)",
  "inkshadow_invitation_matches_current_account(TEXT)",
  "inkshadow_is_sorted_unique_text_array(TEXT[], INTEGER)",
  "inkshadow_lock_team_invitation_outbox_delivery(UUID, UUID, BIGINT, TIMESTAMPTZ)",
  "inkshadow_mark_team_invitation_outbox_delivered(UUID, UUID, BIGINT, TIMESTAMPTZ)",
  "inkshadow_marketplace_is_author(UUID)",
  "inkshadow_marketplace_is_public_version(UUID, UUID)",
  "inkshadow_marketplace_json_is_data_only(JSONB)",
  "inkshadow_marketplace_role()",
  "inkshadow_marketplace_text_is_safe(TEXT)",
  "inkshadow_purge_team_project_key_envelopes_batch(UUID, UUID, INTEGER)",
  "inkshadow_retry_team_invitation_outbox(UUID, UUID, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN)",
  "inkshadow_review_resource_belongs_to_project(UUID, UUID, UUID)",
  "inkshadow_revoke_account_team_access(UUID, TIMESTAMPTZ, UUID)",
  "inkshadow_team_has_active_project_assignment(UUID, UUID, UUID)",
  "inkshadow_team_project_key_envelope_belongs_to_project(UUID, UUID, UUID)",
  "inkshadow_terminalize_team_invitation_outbox(UUID, UUID, UUID, TIMESTAMPTZ, TEXT)",
  "invalidate_cloud_team_project_key_envelopes()",
  "reject_cloud_account_resurrection()",
  "reject_cloud_ai_usage_history_mutation()",
  "reject_cloud_audit_mutation()",
  "reject_cloud_marketplace_append_only_mutation()",
  "reject_cloud_project_resurrection()",
  "reject_cloud_team_audit_mutation()",
  "reject_cloud_team_template_immutable_mutation()",
] as const);

export const CLOUD_SECURITY_DEFINER_FUNCTIONS = Object.freeze([
  "enforce_cloud_account_team_ownership()",
  "enforce_cloud_team_active_owner()",
  "invalidate_cloud_team_project_key_envelopes()",
  "inkshadow_account_has_active_team_access(UUID)",
  "inkshadow_account_requires_ownership_transfer(UUID)",
  "inkshadow_active_team_project_key_envelope_exists(UUID, UUID, UUID, INTEGER, UUID)",
  "inkshadow_cancel_team_invitation_outbox(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT)",
  "inkshadow_claim_team_invitation_outbox(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)",
  "inkshadow_count_review_ciphertexts(UUID, UUID)",
  "inkshadow_count_review_records(UUID, UUID)",
  "inkshadow_count_team_project_key_envelopes(UUID, UUID)",
  "inkshadow_enterprise_public_sso_policy(UUID)",
  "inkshadow_enterprise_required_sso_teams(UUID)",
  "inkshadow_enterprise_resolve_flow(UUID)",
  "inkshadow_enterprise_resolve_member(UUID, TEXT)",
  "inkshadow_has_active_review_assignment(UUID, UUID, UUID)",
  "inkshadow_has_active_team_membership(UUID, UUID)",
  "inkshadow_has_active_team_template_assignment(UUID, UUID, UUID)",
  "inkshadow_invitation_matches_current_account(TEXT)",
  "inkshadow_lock_team_invitation_outbox_delivery(UUID, UUID, BIGINT, TIMESTAMPTZ)",
  "inkshadow_mark_team_invitation_outbox_delivered(UUID, UUID, BIGINT, TIMESTAMPTZ)",
  "inkshadow_marketplace_is_author(UUID)",
  "inkshadow_marketplace_is_public_version(UUID, UUID)",
  "inkshadow_purge_team_project_key_envelopes_batch(UUID, UUID, INTEGER)",
  "inkshadow_retry_team_invitation_outbox(UUID, UUID, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN)",
  "inkshadow_review_resource_belongs_to_project(UUID, UUID, UUID)",
  "inkshadow_revoke_account_team_access(UUID, TIMESTAMPTZ, UUID)",
  "inkshadow_team_has_active_project_assignment(UUID, UUID, UUID)",
  "inkshadow_team_project_key_envelope_belongs_to_project(UUID, UUID, UUID)",
  "inkshadow_terminalize_team_invitation_outbox(UUID, UUID, UUID, TIMESTAMPTZ, TEXT)",
] as const);

const CLOUD_INTERNAL_TABLES = Object.freeze(["cloud_schema_migrations"] as const);
const CLOUD_SECURITY_DEFINER_CONFIGURATION = Object.freeze([
  "search_path=pg_catalog, public",
  "row_security=off",
] as const);

export async function configureCloudDatabaseRoleSeparation(
  client: PoolClient,
  roles: CloudDatabaseRoles,
): Promise<void> {
  validateDistinctRoles(roles);
  const identity = await readDatabaseIdentity(client);
  if (identity.session_role !== roles.migrationRole) {
    throw new Error("The cloud migration connection authenticated as an unexpected role.");
  }
  if (identity.database_owner !== roles.migrationRole) {
    throw new Error("The cloud migration role must own the target database.");
  }

  const roleRows = await readRoleCapabilities(client, roles);
  assertMigrationOwnerRole(roleRows.get(roles.migrationRole));
  assertRuntimeRole(roleRows.get(roles.runtimeRole));
  await assertNoExplicitRoleMemberships(client, roles.migrationRole, "migration");
  await assertNoExplicitRoleMemberships(client, roles.runtimeRole, "runtime");

  const schemaOwner = await client.query<SchemaOwnerRow>(
    `SELECT pg_get_userbyid(nspowner) AS schema_owner
     FROM pg_namespace
     WHERE nspname = 'public'`,
  );
  if (schemaOwner.rows[0]?.schema_owner !== roles.migrationRole) {
    throw new Error("The cloud migration role must own the public schema.");
  }
  await assertRoleOwnsNoDatabaseObjects(client, roles.runtimeRole);

  const databaseIdentifier = quoteServerIdentifier(identity.database_name);
  const migrationIdentifier = quoteStrictRoleIdentifier(roles.migrationRole);
  const runtimeIdentifier = quoteStrictRoleIdentifier(roles.runtimeRole);
  const runtimeTables = CLOUD_RUNTIME_TABLES.map(
    (table) => `public.${quoteStrictSchemaObjectIdentifier(table)}`,
  ).join(", ");
  const runtimeSequences = CLOUD_RUNTIME_SEQUENCES.map(
    (sequence) => `public.${quoteStrictSchemaObjectIdentifier(sequence)}`,
  ).join(", ");
  const runtimeFunctions = CLOUD_RUNTIME_FUNCTIONS.map((signature) => `public.${signature}`).join(
    ", ",
  );

  await client.query("BEGIN");
  try {
    await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${databaseIdentifier} FROM PUBLIC`);
    await client.query(
      `REVOKE CREATE, TEMPORARY ON DATABASE ${databaseIdentifier} FROM ${runtimeIdentifier}`,
    );
    await client.query("REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC");
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${runtimeIdentifier}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${runtimeIdentifier}`);

    await client.query("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC");
    await client.query("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC");
    await client.query("REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC");
    await client.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${runtimeIdentifier}`,
    );
    await client.query(
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${runtimeIdentifier}`,
    );
    await client.query(
      `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ${runtimeIdentifier}`,
    );

    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${runtimeTables} TO ${runtimeIdentifier}`,
    );
    await client.query(
      `GRANT USAGE, SELECT ON SEQUENCE ${runtimeSequences} TO ${runtimeIdentifier}`,
    );
    await client.query(`GRANT EXECUTE ON FUNCTION ${runtimeFunctions} TO ${runtimeIdentifier}`);

    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrationIdentifier} IN SCHEMA public
       REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrationIdentifier} IN SCHEMA public
       REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrationIdentifier} IN SCHEMA public
       REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC`,
    );
    await client.query("COMMIT");
  } catch (cause: unknown) {
    await client.query("ROLLBACK");
    throw cause;
  }

  await assertCloudRuntimeRolePrivileges(client, roles);
}

export async function assertCloudRuntimeDatabaseSecurity(
  pool: Pool,
  roles: CloudDatabaseRoles,
): Promise<void> {
  validateDistinctRoles(roles);
  const client = await pool.connect();
  try {
    const identity = await readDatabaseIdentity(client);
    if (identity.session_role !== roles.runtimeRole) {
      throw new Error("The cloud runtime connection authenticated as an unexpected role.");
    }
    const roleRows = await readRoleCapabilities(client, roles);
    assertRuntimeRole(roleRows.get(roles.runtimeRole));
    await assertNoExplicitRoleMemberships(client, roles.runtimeRole, "runtime");
    await assertCloudRuntimeRolePrivileges(client, roles);
  } finally {
    client.release();
  }
}

export function validateCloudDatabaseRole(role: string, label: string): string {
  if (!POSTGRES_ROLE_PATTERN.test(role)) {
    throw new Error(
      `${label} must be a lowercase PostgreSQL identifier of at most 63 ASCII characters.`,
    );
  }
  return role;
}

async function assertCloudRuntimeRolePrivileges(
  client: PoolClient,
  roles: CloudDatabaseRoles,
): Promise<void> {
  const membership = await client.query<BooleanRow>(
    "SELECT pg_has_role($1::name, $2::name, 'MEMBER') AS value",
    [roles.runtimeRole, roles.migrationRole],
  );
  if (membership.rows[0]?.value !== false) {
    throw new Error("The cloud runtime role must not be a member of the migration role.");
  }

  const databaseDdl = await client.query<BooleanRow>(
    `SELECT (
       has_database_privilege($1::name, current_database(), 'CREATE')
       OR has_database_privilege($1::name, current_database(), 'TEMPORARY')
     ) AS value`,
    [roles.runtimeRole],
  );
  if (databaseDdl.rows[0]?.value !== false) {
    throw new Error("The cloud runtime role must not have database DDL privileges.");
  }

  const schemaDdl = await client.query<CountRow>(
    `SELECT count(*)::text AS count
     FROM pg_namespace
     WHERE has_schema_privilege($1::name, oid, 'CREATE')`,
    [roles.runtimeRole],
  );
  if (schemaDdl.rows[0]?.count !== "0") {
    throw new Error("The cloud runtime role must not have schema DDL privileges.");
  }

  await assertRoleOwnsNoDatabaseObjects(client, roles.runtimeRole);

  const ledger = await client.query<
    BooleanRow & {
      readonly ledger_exists: boolean;
      readonly ledger_owner: string | null;
    }
  >(
    `SELECT
       to_regclass('public.cloud_schema_migrations') IS NOT NULL AS ledger_exists,
       (
         SELECT pg_get_userbyid(relation.relowner)
         FROM pg_class AS relation
         WHERE relation.oid = to_regclass('public.cloud_schema_migrations')
       ) AS ledger_owner,
       (
         has_table_privilege($1::name, 'public.cloud_schema_migrations', 'SELECT')
         OR has_table_privilege($1::name, 'public.cloud_schema_migrations', 'INSERT')
         OR has_table_privilege($1::name, 'public.cloud_schema_migrations', 'UPDATE')
         OR has_table_privilege($1::name, 'public.cloud_schema_migrations', 'DELETE')
         OR has_table_privilege($1::name, 'public.cloud_schema_migrations', 'TRUNCATE')
         OR has_table_privilege($1::name, 'public.cloud_schema_migrations', 'REFERENCES')
         OR has_table_privilege($1::name, 'public.cloud_schema_migrations', 'TRIGGER')
       ) AS value`,
    [roles.runtimeRole],
  );
  const ledgerStatus = ledger.rows[0];
  if (
    ledgerStatus === undefined ||
    !ledgerStatus.ledger_exists ||
    ledgerStatus.ledger_owner !== roles.migrationRole ||
    ledgerStatus.value
  ) {
    throw new Error("The cloud runtime role must not access the migration ledger.");
  }
  await assertRuntimeObjectAccess(client, roles);
}

async function assertRuntimeObjectAccess(
  client: PoolClient,
  roles: CloudDatabaseRoles,
): Promise<void> {
  const tableResult = await client.query<TableAccessRow>(
    `SELECT
       relation.relforcerowsecurity AS force_row_security,
       relation.relname AS object_name,
       pg_get_userbyid(relation.relowner) AS owner_name,
       (
         EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner)))
           WHERE grantee = 0
         )
       ) AS public_has_privilege,
       relation.relrowsecurity AS row_security,
       has_table_privilege($1::name, relation.oid, 'SELECT') AS runtime_select,
       has_table_privilege($1::name, relation.oid, 'INSERT') AS runtime_insert,
       has_table_privilege($1::name, relation.oid, 'UPDATE') AS runtime_update,
       has_table_privilege($1::name, relation.oid, 'DELETE') AS runtime_delete,
       has_table_privilege($1::name, relation.oid, 'TRUNCATE') AS runtime_truncate,
       has_table_privilege($1::name, relation.oid, 'REFERENCES') AS runtime_references,
       has_table_privilege($1::name, relation.oid, 'TRIGGER') AS runtime_trigger
     FROM pg_class AS relation
     INNER JOIN pg_namespace AS namespace
       ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
     ORDER BY relation.relname`,
    [roles.runtimeRole],
  );
  const expectedTables = new Set<string>(CLOUD_RUNTIME_TABLES);
  const expectedForceRlsTables = new Set<string>(CLOUD_FORCE_RLS_TABLES);
  const expectedInternalTables = new Set<string>(CLOUD_INTERNAL_TABLES);
  const observedTables = new Set<string>();
  const observedInternalTables = new Set<string>();
  for (const table of tableResult.rows) {
    if (table.public_has_privilege) {
      throw new Error("PUBLIC must not have privileges on cloud tables.");
    }
    if (expectedTables.has(table.object_name)) {
      observedTables.add(table.object_name);
      const expectsForcedRowSecurity = expectedForceRlsTables.has(table.object_name);
      if (expectsForcedRowSecurity && (!table.row_security || !table.force_row_security)) {
        throw new Error(
          "A declared FORCE RLS table must keep row-level security enabled and forced.",
        );
      }
      if (!expectsForcedRowSecurity && (table.row_security || table.force_row_security)) {
        throw new Error("A cloud runtime table has an undeclared row-level security state.");
      }
      if (
        table.owner_name !== roles.migrationRole ||
        !table.runtime_select ||
        !table.runtime_insert ||
        !table.runtime_update ||
        !table.runtime_delete ||
        table.runtime_truncate ||
        table.runtime_references ||
        table.runtime_trigger
      ) {
        throw new Error("A declared cloud runtime table has an invalid owner or ACL.");
      }
    } else if (expectedInternalTables.has(table.object_name)) {
      observedInternalTables.add(table.object_name);
      if (
        table.owner_name !== roles.migrationRole ||
        table.runtime_select ||
        table.runtime_insert ||
        table.runtime_update ||
        table.runtime_delete ||
        table.runtime_truncate ||
        table.runtime_references ||
        table.runtime_trigger
      ) {
        throw new Error("An internal cloud table has an invalid owner or ACL.");
      }
    } else {
      throw new Error("The public schema contains an undeclared cloud relation.");
    }
  }
  if (
    [...expectedForceRlsTables].some((table) => !expectedTables.has(table)) ||
    observedTables.size !== expectedTables.size ||
    [...expectedTables].some((table) => !observedTables.has(table)) ||
    observedInternalTables.size !== expectedInternalTables.size ||
    [...expectedInternalTables].some((table) => !observedInternalTables.has(table))
  ) {
    throw new Error("The declared cloud relation allowlist does not match the schema.");
  }

  const sequenceResult = await client.query<SequenceAccessRow>(
    `SELECT
       relation.relname AS object_name,
       pg_get_userbyid(relation.relowner) AS owner_name,
       (
         EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(relation.relacl, acldefault('S', relation.relowner)))
           WHERE grantee = 0
         )
       ) AS public_has_privilege,
       has_sequence_privilege($1::name, relation.oid, 'USAGE') AS runtime_usage,
       has_sequence_privilege($1::name, relation.oid, 'SELECT') AS runtime_select,
       has_sequence_privilege($1::name, relation.oid, 'UPDATE') AS runtime_update
     FROM pg_class AS relation
     INNER JOIN pg_namespace AS namespace
       ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind = 'S'
     ORDER BY relation.relname`,
    [roles.runtimeRole],
  );
  const expectedSequences = new Set<string>(CLOUD_RUNTIME_SEQUENCES);
  const observedSequences = new Set<string>();
  for (const sequence of sequenceResult.rows) {
    if (sequence.public_has_privilege) {
      throw new Error("PUBLIC must not have privileges on cloud sequences.");
    }
    if (expectedSequences.has(sequence.object_name)) {
      observedSequences.add(sequence.object_name);
      if (
        sequence.owner_name !== roles.migrationRole ||
        !sequence.runtime_usage ||
        !sequence.runtime_select ||
        sequence.runtime_update
      ) {
        throw new Error("A declared cloud runtime sequence has an invalid owner or ACL.");
      }
    } else {
      throw new Error("The public schema contains an undeclared cloud sequence.");
    }
  }
  if (
    observedSequences.size !== expectedSequences.size ||
    [...expectedSequences].some((sequence) => !observedSequences.has(sequence))
  ) {
    throw new Error("The declared cloud runtime sequence allowlist does not match the schema.");
  }

  // Migration checksums protect the applied migration history, but the migration
  // owner can still alter a live routine. Verify the security-sensitive catalog
  // attributes directly on every startup instead of trusting history alone.
  const functionResult = await client.query<FunctionAccessRow>(
    `SELECT
       routine.proconfig AS configuration,
       routine.proname || '(' || oidvectortypes(routine.proargtypes) || ')' AS function_identity,
       pg_get_userbyid(routine.proowner) AS owner_name,
       (
         EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(routine.proacl, acldefault('f', routine.proowner)))
           WHERE grantee = 0
         )
       ) AS public_execute,
       has_function_privilege($1::name, routine.oid, 'EXECUTE') AS runtime_execute,
       routine.prosecdef AS security_definer
     FROM pg_proc AS routine
     INNER JOIN pg_namespace AS namespace
       ON namespace.oid = routine.pronamespace
     WHERE namespace.nspname = 'public'
     ORDER BY function_identity`,
    [roles.runtimeRole],
  );
  const expectedFunctions = new Set(
    CLOUD_RUNTIME_FUNCTIONS.map(normalizeDeclaredFunctionSignature),
  );
  const expectedSecurityDefinerFunctions = new Set(
    CLOUD_SECURITY_DEFINER_FUNCTIONS.map(normalizeDeclaredFunctionSignature),
  );
  const observedFunctions = new Set<string>();
  for (const routine of functionResult.rows) {
    if (routine.public_execute) {
      throw new Error("PUBLIC must not execute cloud functions.");
    }
    if (expectedFunctions.has(routine.function_identity)) {
      observedFunctions.add(routine.function_identity);
      const expectsSecurityDefiner = expectedSecurityDefinerFunctions.has(
        routine.function_identity,
      );
      if (
        routine.owner_name !== roles.migrationRole ||
        !routine.runtime_execute ||
        routine.security_definer !== expectsSecurityDefiner ||
        !hasExpectedFunctionConfiguration(routine.configuration, expectsSecurityDefiner)
      ) {
        throw new Error(
          "A declared cloud runtime function has invalid owner, ACL or security attributes.",
        );
      }
    } else {
      throw new Error("The public schema contains an undeclared cloud function.");
    }
  }
  if (
    observedFunctions.size !== expectedFunctions.size ||
    [...expectedFunctions].some((routine) => !observedFunctions.has(routine))
  ) {
    throw new Error("The declared cloud runtime function allowlist does not match the schema.");
  }
}

async function assertRoleOwnsNoDatabaseObjects(
  client: PoolClient,
  runtimeRole: string,
): Promise<void> {
  const ownership = await client.query<CountRow>(
    `WITH runtime_role AS (
       SELECT oid
       FROM pg_roles
       WHERE rolname = $1
     )
     SELECT count(*)::text AS count
     FROM pg_shdepend AS dependency
     INNER JOIN runtime_role
       ON runtime_role.oid = dependency.refobjid
     WHERE dependency.refclassid = 'pg_authid'::regclass
       AND dependency.deptype = 'o'`,
    [runtimeRole],
  );
  if (ownership.rows[0]?.count !== "0") {
    throw new Error("The cloud runtime role must not own database objects.");
  }
}

async function assertNoExplicitRoleMemberships(
  client: PoolClient,
  role: string,
  label: string,
): Promise<void> {
  const memberships = await client.query<CountRow>(
    `WITH RECURSIVE granted_roles(role_oid) AS (
       SELECT membership.roleid
       FROM pg_auth_members AS membership
       INNER JOIN pg_roles AS member_role
         ON member_role.oid = membership.member
       WHERE member_role.rolname = $1
       UNION
       SELECT membership.roleid
       FROM pg_auth_members AS membership
       INNER JOIN granted_roles
         ON granted_roles.role_oid = membership.member
     )
     SELECT count(*)::text AS count
     FROM granted_roles`,
    [role],
  );
  if (memberships.rows[0]?.count !== "0") {
    throw new Error(`The cloud ${label} role must not inherit or assume another role.`);
  }
  const grantees = await client.query<CountRow>(
    `SELECT count(*)::text AS count
     FROM pg_auth_members AS membership
     INNER JOIN pg_roles AS granted_role
       ON granted_role.oid = membership.roleid
     WHERE granted_role.rolname = $1`,
    [role],
  );
  if (grantees.rows[0]?.count !== "0") {
    throw new Error(`The cloud ${label} role must not be granted to another role.`);
  }
}

async function readDatabaseIdentity(client: PoolClient): Promise<DatabaseIdentityRow> {
  const result = await client.query<DatabaseIdentityRow>(
    `SELECT
       current_database() AS database_name,
       pg_get_userbyid(database.datdba) AS database_owner,
       current_user AS session_role
     FROM pg_database AS database
     WHERE database.datname = current_database()`,
  );
  const identity = result.rows[0];
  if (identity === undefined) {
    throw new Error("The cloud PostgreSQL database identity could not be verified.");
  }
  return identity;
}

async function readRoleCapabilities(
  client: PoolClient,
  roles: CloudDatabaseRoles,
): Promise<ReadonlyMap<string, RoleCapabilityRow>> {
  const result = await client.query<RoleCapabilityRow>(
    `SELECT
       rolname,
       rolsuper,
       rolcreatedb,
       rolcreaterole,
       rolreplication,
       rolbypassrls,
       rolcanlogin,
       rolinherit
     FROM pg_roles
     WHERE rolname = ANY($1::name[])`,
    [[roles.migrationRole, roles.runtimeRole]],
  );
  return new Map(result.rows.map((row) => [row.rolname, row]));
}

function assertMigrationOwnerRole(role: RoleCapabilityRow | undefined): void {
  if (
    role === undefined ||
    !role.rolcanlogin ||
    role.rolsuper ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    !role.rolbypassrls
  ) {
    throw new Error(
      "The cloud migration role must be LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and BYPASSRLS.",
    );
  }
}

function assertRuntimeRole(role: RoleCapabilityRow | undefined): void {
  if (
    role === undefined ||
    !role.rolcanlogin ||
    role.rolsuper ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolbypassrls
  ) {
    throw new Error(
      "The cloud runtime role must be LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and NOBYPASSRLS.",
    );
  }
}

function validateDistinctRoles(roles: CloudDatabaseRoles): void {
  validateCloudDatabaseRole(roles.migrationRole, "Cloud migration role");
  validateCloudDatabaseRole(roles.runtimeRole, "Cloud runtime role");
  if (roles.migrationRole === roles.runtimeRole) {
    throw new Error("Cloud migration and runtime roles must be distinct.");
  }
}

function normalizeDeclaredFunctionSignature(signature: string): string {
  return signature.toLowerCase().replaceAll("timestamptz", "timestamp with time zone");
}

function hasExpectedFunctionConfiguration(
  configuration: readonly string[] | null,
  securityDefiner: boolean,
): boolean {
  if (!securityDefiner) {
    return configuration === null;
  }
  return (
    configuration !== null &&
    configuration.length === CLOUD_SECURITY_DEFINER_CONFIGURATION.length &&
    CLOUD_SECURITY_DEFINER_CONFIGURATION.every((entry) => configuration.includes(entry))
  );
}

function quoteStrictRoleIdentifier(role: string): string {
  return `"${validateCloudDatabaseRole(role, "Cloud database role")}"`;
}

function quoteStrictSchemaObjectIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(identifier)) {
    throw new Error("A declared cloud database object identifier is invalid.");
  }
  return `"${identifier}"`;
}

function quoteServerIdentifier(identifier: string): string {
  if (identifier.length === 0 || identifier.includes("\0")) {
    throw new Error("The cloud PostgreSQL database identifier is invalid.");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}
