import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CONTRACT_SCHEMA_VERSION,
  type CloudTeamTemplateCiphertextEnvelope,
  type CloudTeamTemplateCreateRequest,
} from "@inkshadow/contracts";
import type { Pool, PoolClient } from "pg";

import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { PostgresCloudTeamTemplateStore } from "../src/postgres/team-template-store.js";
import { CloudPageCursorCodec } from "../src/security/page-cursor.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import type { CloudPrincipal } from "../src/service/identity-service.js";
import { CloudTeamTemplateService } from "../src/service/team-template-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const now = new Date("2026-07-28T10:00:00.000Z");

describePostgres("PostgreSQL encrypted team-template service", () => {
  let pool: Pool;
  let uuid: ReturnType<typeof createMonotonicUuidV7Factory>;
  let service: CloudTeamTemplateService;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      applicationName: "inkshadow-team-template-test",
      connectionString: databaseUrl,
      maximumConnections: 12,
      requireTls: false,
    });
    await runCloudMigrations(pool);
    uuid = createMonotonicUuidV7Factory(
      () => now.getTime(),
      (target) => randomBytes(target.length).copy(target),
    );
    service = new CloudTeamTemplateService({
      clock: () => now,
      pageCursorCodec: new CloudPageCursorCodec(Buffer.alloc(32, 0x74)),
      store: new PostgresCloudTeamTemplateStore(pool),
      uuid,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("enforces encrypted immutable lifecycle, role gates, exact replay and local-only apply receipts", async () => {
    const fixture = await seedFixture(pool, uuid, "template-lifecycle");
    const templateId = uuid();
    const versionOneId = uuid();
    const create = createRequest(fixture, templateId, versionOneId, 1, 0x21);
    const created = await service.createTemplate(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      create,
      mutation(uuid(), "template-create-idempotency-0001"),
    );
    const replay = await service.createTemplate(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      create,
      mutation(uuid(), "template-create-idempotency-0001"),
    );
    expect(replay.requestId).not.toBe(created.requestId);
    expect(replay.template).toEqual(created.template);
    expect(replay.version).toEqual(created.version);
    expect(created).toMatchObject({
      template: { state: "draft", revision: 1, latestVersionNumber: 1 },
      version: { authorDeviceId: fixture.author.deviceId, versionNumber: 1 },
    });

    await expect(
      service.createTemplate(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        { ...create, templateId: uuid() },
        mutation(uuid(), "template-create-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const versionTwoId = uuid();
    const secondPayload = payload(fixture, templateId, versionTwoId, 2, 0x22);
    const second = await service.createVersion(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      templateId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        authorDeviceId: fixture.author.deviceId,
        expectedRevision: created.template.revision,
        payload: secondPayload,
        projectKeyVersion: 1,
        versionId: versionTwoId,
        versionNumber: 2,
      },
      mutation(uuid(), "template-version-idempotency-0001"),
    );
    expect(second.template).toMatchObject({ latestVersionNumber: 2, revision: 2 });

    await expect(
      service.publishTemplate(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        templateId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: second.template.revision,
          versionId: versionTwoId,
        },
        mutation(uuid(), "template-author-publish-denied-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });

    const published = await service.publishTemplate(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      templateId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: second.template.revision,
        versionId: versionTwoId,
      },
      mutation(uuid(), "template-owner-publish-0001"),
    );
    expect(published.template).toMatchObject({
      state: "published",
      publishedVersionNumber: 2,
      revision: 3,
    });

    const readOnlyPage = await service.listTemplates(
      fixture.readOnly,
      fixture.teamId,
      fixture.projectId,
      null,
      50,
      read(uuid()),
    );
    expect(readOnlyPage.templates).toEqual([
      expect.objectContaining({ templateId, state: "published" }),
    ]);
    const encryptedVersion = await service.getVersion(
      fixture.reviewer,
      fixture.teamId,
      fixture.projectId,
      templateId,
      versionTwoId,
      read(uuid()),
    );
    expect(encryptedVersion.version.payload).toEqual(secondPayload);

    await expect(
      service.recordApplication(
        fixture.reviewer,
        fixture.teamId,
        fixture.projectId,
        templateId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          applicationId: uuid(),
          expectedRevision: published.template.revision,
          versionId: versionTwoId,
        },
        mutation(uuid(), "template-reviewer-apply-denied-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });

    const applicationId = uuid();
    const application = await service.recordApplication(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      templateId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        applicationId,
        expectedRevision: published.template.revision,
        versionId: versionTwoId,
      },
      mutation(uuid(), "template-application-idempotency-0001"),
    );
    expect(application).toMatchObject({
      applicationId,
      effect: "metadata_only_no_server_content_mutation",
      versionId: versionTwoId,
    });

    const cloneTemplateId = uuid();
    const cloneVersionId = uuid();
    const clone = await service.cloneTemplate(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      templateId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        authorDeviceId: fixture.author.deviceId,
        expectedSourceRevision: published.template.revision,
        payload: payload(fixture, cloneTemplateId, cloneVersionId, 1, 0x23),
        projectKeyVersion: 1,
        sourceVersionId: versionTwoId,
        targetTemplateId: cloneTemplateId,
        versionId: cloneVersionId,
        versionNumber: 1,
      },
      mutation(uuid(), "template-clone-idempotency-0001"),
    );
    expect(clone).toMatchObject({
      template: { state: "draft", templateId: cloneTemplateId },
      version: {
        clonedFromTemplateId: templateId,
        clonedFromVersionId: versionTwoId,
      },
    });

    const archived = await service.archiveTemplate(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      templateId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: published.template.revision,
      },
      mutation(uuid(), "template-archive-idempotency-0001"),
    );
    expect(archived.template).toMatchObject({
      state: "archived",
      publishedVersionNumber: 2,
      revision: 4,
    });
    const recoveredApplicationId = uuid();
    await expect(
      service.recordApplication(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        templateId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          applicationId: recoveredApplicationId,
          expectedRevision: published.template.revision,
          versionId: versionTwoId,
        },
        mutation(uuid(), "template-archived-recovery-application-0001"),
      ),
    ).resolves.toMatchObject({
      applicationId: recoveredApplicationId,
      effect: "metadata_only_no_server_content_mutation",
      versionId: versionTwoId,
    });
    await expect(
      service.recordApplication(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        templateId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          applicationId: uuid(),
          expectedRevision: archived.template.revision,
          versionId: versionTwoId,
        },
        mutation(uuid(), "template-archived-new-application-rejected-0001"),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(
      service.getTemplate(
        fixture.readOnly,
        fixture.teamId,
        fixture.projectId,
        templateId,
        read(uuid()),
      ),
    ).resolves.toMatchObject({ template: { state: "archived" } });
    await expect(
      service.createVersion(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        templateId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          authorDeviceId: fixture.author.deviceId,
          expectedRevision: archived.template.revision,
          payload: payload(fixture, templateId, uuid(), 3, 0x24),
          projectKeyVersion: 1,
          versionId: uuid(),
          versionNumber: 3,
        },
        mutation(uuid(), "template-archived-version-rejected-0001"),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    await expect(
      service.listTemplates(
        fixture.finance,
        fixture.teamId,
        fixture.projectId,
        null,
        50,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });

    const stored = await setTemplateScope(pool, fixture.author, fixture, async (client) => {
      return client.query<{
        payload_ciphertext: string;
        author_device_id: string;
      }>(
        `SELECT payload_ciphertext, author_device_id
         FROM cloud_team_template_versions
         WHERE template_id = $1
         ORDER BY version_number`,
        [templateId],
      );
    });
    expect(stored.rows).toEqual([
      { payload_ciphertext: create.payload.ciphertext, author_device_id: fixture.author.deviceId },
      { payload_ciphertext: secondPayload.ciphertext, author_device_id: fixture.author.deviceId },
    ]);
    const audit = await pool.query<{ redacted_diff: string }>(
      `SELECT redacted_diff::text
       FROM cloud_team_audit_events
       WHERE resource_id = ANY($1::uuid[])`,
      [[templateId, versionTwoId, applicationId]],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const row of audit.rows) {
      expect(row.redacted_diff).not.toContain(create.payload.ciphertext);
      expect(row.redacted_diff).not.toContain(secondPayload.ciphertext);
    }
  });

  it("fails closed on ciphertext tampering, wrong devices, revoked assignments and project state", async () => {
    const fixture = await seedFixture(pool, uuid, "template-fail-closed");
    const request = createRequest(fixture, uuid(), uuid(), 1, 0x31);
    await expect(
      service.createTemplate(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        {
          ...request,
          payload: { ...request.payload, ciphertextSha256: "0".repeat(64) },
        },
        mutation(uuid(), "template-invalid-ciphertext-0001"),
      ),
    ).rejects.toMatchObject({ code: "SYNC_INVALID_CIPHERTEXT" });
    await expect(
      service.createTemplate(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        { ...request, authorDeviceId: fixture.owner.deviceId },
        mutation(uuid(), "template-wrong-device-0001"),
      ),
    ).rejects.toMatchObject({ code: "SYNC_INVALID_CIPHERTEXT" });

    await setTemplateScope(pool, fixture.owner, fixture, async (client) => {
      await client.query(
        `UPDATE cloud_project_assignments
         SET state = 'revoked',
             revision = revision + 1,
             revoked_by_membership_id = $5,
             revoked_at = $6,
             updated_at = $6
         WHERE tenant_id = $1
           AND team_id = $2
           AND project_id = $3
           AND membership_id = $4`,
        [
          fixture.owner.accountId,
          fixture.teamId,
          fixture.projectId,
          fixture.authorMembershipId,
          fixture.ownerMembershipId,
          now,
        ],
      );
    });
    await expect(
      service.createTemplate(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        request,
        mutation(uuid(), "template-revoked-assignment-0001"),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    await setTenant(pool, fixture.owner.accountId, async (client) => {
      await client.query(
        `UPDATE cloud_projects
         SET state = 'deletion_scheduled',
             deletion_scheduled_for = $3,
             revision = revision + 1,
             updated_at = $3
         WHERE tenant_id = $1
           AND project_id = $2`,
        [fixture.owner.accountId, fixture.projectId, now],
      );
    });
    await expect(
      service.listTemplates(
        fixture.owner,
        fixture.teamId,
        fixture.projectId,
        null,
        50,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("enforces FORCE RLS and append-only history under a real NOBYPASSRLS role", async () => {
    const fixture = await seedFixture(pool, uuid, "template-rls");
    const request = createRequest(fixture, uuid(), uuid(), 1, 0x41);
    await service.createTemplate(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      request,
      mutation(uuid(), "template-rls-create-0001"),
    );

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'inkshadow_template_rls_test'
        ) THEN
          CREATE ROLE inkshadow_template_rls_test LOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$
    `);
    await pool.query("ALTER ROLE inkshadow_template_rls_test LOGIN NOSUPERUSER NOBYPASSRLS");
    await pool.query("GRANT USAGE ON SCHEMA public TO inkshadow_template_rls_test");
    await pool.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO inkshadow_template_rls_test",
    );
    await pool.query(
      `GRANT EXECUTE
         ON FUNCTION inkshadow_has_active_team_template_assignment(UUID, UUID, UUID)
         TO inkshadow_template_rls_test`,
    );

    const limitedUrl = new URL(databaseUrl ?? "");
    limitedUrl.username = "inkshadow_template_rls_test";
    limitedUrl.password = "";
    const limitedPool = createCloudPostgresPool({
      applicationName: "inkshadow-template-rls-role-test",
      connectionString: limitedUrl.toString(),
      maximumConnections: 1,
      requireTls: false,
    });
    const client = await limitedPool.connect();
    try {
      const role = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
        `SELECT rolsuper, rolbypassrls
         FROM pg_roles
         WHERE rolname = current_user`,
      );
      expect(role.rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
      expect((await client.query("SELECT template_id FROM cloud_team_templates")).rows).toEqual([]);

      await client.query("BEGIN");
      await setLimitedScope(client, fixture.author, fixture);
      expect(
        (
          await client.query<{ template_id: string }>(
            "SELECT template_id FROM cloud_team_templates WHERE template_id = $1",
            [request.templateId],
          )
        ).rows,
      ).toEqual([{ template_id: request.templateId }]);
      await expect(
        client.query(
          `UPDATE cloud_team_template_versions
           SET payload_ciphertext = $2
           WHERE version_id = $1`,
          [
            request.versionId,
            payload(fixture, request.templateId, request.versionId, 1, 0x42).ciphertext,
          ],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await setLimitedScope(client, fixture.readOnly, fixture);
      expect((await client.query("SELECT template_id FROM cloud_team_templates")).rows).toEqual([
        { template_id: request.templateId },
      ]);
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await setLimitedScope(client, fixture.finance, fixture);
      expect((await client.query("SELECT template_id FROM cloud_team_templates")).rows).toEqual([]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await limitedPool.end();
    }

    const forbiddenColumns = await pool.query<{ column_name: string; table_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_name = ANY($1::text[])
         AND column_name ~ '(title|body|content|prompt|rules|plaintext|dek|recovery|private_key)'
       ORDER BY table_name, column_name`,
      [
        [
          "cloud_team_templates",
          "cloud_team_template_versions",
          "cloud_team_template_applications",
        ],
      ],
    );
    expect(forbiddenColumns.rows).toEqual([]);
  });
});

interface SeededPrincipal extends CloudPrincipal {
  readonly email: string;
}

interface TemplateFixture {
  readonly author: SeededPrincipal;
  readonly authorMembershipId: string;
  readonly finance: SeededPrincipal;
  readonly owner: SeededPrincipal;
  readonly ownerMembershipId: string;
  readonly projectId: string;
  readonly readOnly: SeededPrincipal;
  readonly reviewer: SeededPrincipal;
  readonly teamId: string;
}

async function seedFixture(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  label: string,
): Promise<TemplateFixture> {
  const owner = await seedPrincipal(pool, uuid, `${label}-owner`, "A");
  const author = await seedPrincipal(pool, uuid, `${label}-author`, "B");
  const reviewer = await seedPrincipal(pool, uuid, `${label}-reviewer`, "C");
  const readOnly = await seedPrincipal(pool, uuid, `${label}-read-only`, "D");
  const finance = await seedPrincipal(pool, uuid, `${label}-finance`, "E");
  const projectId = uuid();
  const teamId = uuid();
  const ownerMembershipId = uuid();
  const authorMembershipId = uuid();
  const memberships = [
    [ownerMembershipId, owner.accountId, "owner"],
    [authorMembershipId, author.accountId, "author"],
    [uuid(), reviewer.accountId, "reviewer"],
    [uuid(), readOnly.accountId, "read_only"],
    [uuid(), finance.accountId, "finance_admin"],
  ] as const;

  await setTenant(pool, owner.accountId, async (client) => {
    await client.query(
      `INSERT INTO cloud_projects (
         tenant_id, project_id, owner_account_id, state, current_key_version,
         revision, created_at, updated_at
       ) VALUES ($1, $2, $1, 'active', 1, 1, $3, $3)`,
      [owner.accountId, projectId, now],
    );
    await client.query(
      `INSERT INTO project_key_versions (
         tenant_id, project_id, key_version, server_revision, algorithm, state,
         client_revision, recovery_id, recovery_algorithm, recovery_salt,
         recovery_nonce, recovery_ciphertext, recovery_verifier,
         recovery_created_at, recovery_confirmed_at, created_at, updated_at,
         publication_request_sha256, publication_published_at
       ) VALUES (
         $1, $2, 1, 1, 'AES-256-GCM', 'active', 1, $3,
         'ARGON2ID-AES256GCM', $4, $5, $6, $7, $8, $8, $8, $8, $9, $8
       )`,
      [
        owner.accountId,
        projectId,
        uuid(),
        "S".repeat(22),
        "N".repeat(16),
        "R".repeat(64),
        "V".repeat(43),
        now,
        sha256(`template-publication-${projectId}`),
      ],
    );
  });

  await setTeamScope(pool, owner, owner.accountId, teamId, async (client) => {
    await client.query(
      `INSERT INTO cloud_teams (
         tenant_id, team_id, display_name, state, revision, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', 1, $4, $4)`,
      [owner.accountId, teamId, `${label} Studio`, now],
    );
    for (const [membershipId, accountId, role] of memberships) {
      await client.query(
        `INSERT INTO cloud_team_memberships (
           tenant_id, team_id, membership_id, account_id, role, state,
           revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $6)`,
        [owner.accountId, teamId, membershipId, accountId, role, now],
      );
      await client.query(
        `INSERT INTO cloud_project_assignments (
           tenant_id, team_id, project_id, membership_id, assignment_id, state,
           revision, granted_by_membership_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $7, $7)`,
        [owner.accountId, teamId, projectId, membershipId, uuid(), ownerMembershipId, now],
      );
    }
  });
  return {
    author,
    authorMembershipId,
    finance,
    owner,
    ownerMembershipId,
    projectId,
    readOnly,
    reviewer,
    teamId,
  };
}

async function seedPrincipal(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  label: string,
  publicKeyCharacter: string,
): Promise<SeededPrincipal> {
  const accountId = uuid();
  const deviceId = uuid();
  const sessionId = uuid();
  const email = `${label}-${accountId}@example.test`;
  await pool.query(
    `INSERT INTO cloud_accounts (
       account_id, email_canonical, password_hash, state, verified_at,
       created_at, updated_at
     ) VALUES ($1, $2, $3, 'active', $4, $4, $4)`,
    [accountId, email, `scrypt-test-${"x".repeat(32)}`, now],
  );
  await pool.query(
    `INSERT INTO registered_devices (
       device_id, account_id, display_name, algorithm, public_key,
       public_key_fingerprint, client_version, state, revision, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'DHKEM-P256-HKDF-SHA256', $4, $5, '0.1.0',
       'trusted', 1, $6, $6
     )`,
    [deviceId, accountId, `${label} device`, publicKeyCharacter.repeat(87), sha256(deviceId), now],
  );
  await pool.query(
    `INSERT INTO cloud_sessions (
       session_id, account_id, device_id, client_version, minimum_client_version,
       access_token_hash_sha256, refresh_token_hash_sha256, refresh_generation,
       issued_at, expires_at, refresh_expires_at, last_seen_at
     ) VALUES ($1, $2, $3, '0.1.0', '0.1.0', $4, $5, 1, $6, $7, $8, $6)`,
    [
      sessionId,
      accountId,
      deviceId,
      sha256(`access-${sessionId}`),
      sha256(`refresh-${sessionId}`),
      now,
      new Date(now.getTime() + 60 * 60 * 1_000),
      new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    ],
  );
  return { accountId, deviceId, email, sessionId };
}

function createRequest(
  fixture: TemplateFixture,
  templateId: string,
  versionId: string,
  versionNumber: number,
  fill: number,
): CloudTeamTemplateCreateRequest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    authorDeviceId: fixture.author.deviceId,
    payload: payload(fixture, templateId, versionId, versionNumber, fill),
    projectKeyVersion: 1,
    templateId,
    versionId,
    versionNumber,
  };
}

function payload(
  fixture: TemplateFixture,
  templateId: string,
  versionId: string,
  versionNumber: number,
  fill: number,
): CloudTeamTemplateCiphertextEnvelope {
  const ciphertext = Buffer.alloc(48, fill);
  try {
    return {
      aad: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        purpose: "inkshadow.studio.team-template",
        projectId: fixture.projectId,
        projectKeyVersion: 1,
        teamId: fixture.teamId,
        templateId,
        tenantId: fixture.owner.accountId,
        versionId,
        versionNumber,
      },
      algorithm: "AES-256-GCM",
      ciphertext: ciphertext.toString("base64url"),
      ciphertextSha256: createHash("sha256").update(ciphertext).digest("hex"),
      nonce: Buffer.alloc(12, fill).toString("base64url"),
    };
  } finally {
    ciphertext.fill(0);
  }
}

async function setTenant(
  pool: Pool,
  tenantId: string,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [tenantId]);
    await operation(client);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setTeamScope<T>(
  pool: Pool,
  principal: Pick<SeededPrincipal, "accountId" | "deviceId">,
  tenantId: string,
  teamId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT
         set_config('inkshadow.account_id', $1, true),
         set_config('inkshadow.tenant_id', $2, true),
         set_config('inkshadow.team_id', $3, true),
         set_config('inkshadow.device_id', $4, true)`,
      [principal.accountId, tenantId, teamId, principal.deviceId],
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function setTemplateScope<T>(
  pool: Pool,
  principal: Pick<SeededPrincipal, "accountId" | "deviceId">,
  fixture: TemplateFixture,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return setTeamScope(pool, principal, fixture.owner.accountId, fixture.teamId, operation);
}

function setLimitedScope(
  client: PoolClient,
  principal: Pick<SeededPrincipal, "accountId" | "deviceId">,
  fixture: TemplateFixture,
): Promise<unknown> {
  return client.query(
    `SELECT
       set_config('inkshadow.account_id', $1, true),
       set_config('inkshadow.device_id', $2, true),
       set_config('inkshadow.tenant_id', $3, true),
       set_config('inkshadow.team_id', $4, true)`,
    [principal.accountId, principal.deviceId, fixture.owner.accountId, fixture.teamId],
  );
}

function mutation(requestId: string, idempotencyKey: string) {
  return { idempotencyKey, requestId };
}

function read(requestId: string) {
  return { requestId };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
