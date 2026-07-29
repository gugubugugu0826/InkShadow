import {
  CloudTeamTemplateCiphertextEnvelopeSchema,
  type CloudTeamTemplateAad,
} from "@inkshadow/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { CloudProjectRecord } from "../domain/project-records.js";
import type {
  CloudIdempotencyRecord,
  CloudPageAnchor,
  IdempotencyResultKind,
  RegisteredDeviceRecord,
} from "../domain/records.js";
import type {
  CloudTeamTemplateApplicationRecord,
  CloudTeamTemplateRecord,
  CloudTeamTemplateVersionRecord,
} from "../domain/team-template-records.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamAuditEventRecord,
  CloudTeamMembershipRecord,
  CloudTeamProjectKeyVersionRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type {
  CloudTeamTemplateStore,
  CloudTeamTemplateTransaction,
} from "../repository/team-template-store.js";
import type { CloudPrincipal } from "../service/identity-service.js";

interface MembershipRow extends QueryResultRow {
  readonly account_id: string;
  readonly created_at: Date;
  readonly membership_id: string;
  readonly revision: number | string;
  readonly revoked_at: Date | null;
  readonly role: CloudTeamMembershipRecord["role"];
  readonly state: CloudTeamMembershipRecord["state"];
  readonly team_id: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface TeamRow extends QueryResultRow {
  readonly archived_at: Date | null;
  readonly created_at: Date;
  readonly display_name: string;
  readonly revision: number | string;
  readonly state: CloudTeamRecord["state"];
  readonly team_id: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface ProjectRow extends QueryResultRow {
  readonly created_at: Date;
  readonly current_key_version: number | null;
  readonly deletion_scheduled_for: Date | null;
  readonly minimum_available_remote_sequence: string;
  readonly owner_account_id: string;
  readonly project_id: string;
  readonly revision: number | string;
  readonly state: CloudProjectRecord["state"];
  readonly sync_compaction_epoch: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface AssignmentRow extends QueryResultRow {
  readonly assignment_id: string;
  readonly created_at: Date;
  readonly granted_by_membership_id: string;
  readonly membership_id: string;
  readonly project_id: string;
  readonly revision: number | string;
  readonly revoked_at: Date | null;
  readonly revoked_by_membership_id: string | null;
  readonly state: CloudProjectAssignmentRecord["state"];
  readonly team_id: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface ProjectKeyRow extends QueryResultRow {
  readonly key_version: number;
  readonly project_id: string;
  readonly server_revision: number | string;
  readonly state: CloudTeamProjectKeyVersionRecord["state"];
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface DeviceRow extends QueryResultRow {
  readonly account_id: string;
  readonly algorithm: RegisteredDeviceRecord["algorithm"];
  readonly client_version: string;
  readonly created_at: Date;
  readonly device_id: string;
  readonly display_name: string;
  readonly public_key: string;
  readonly public_key_fingerprint: string;
  readonly revision: number | string;
  readonly revoked_at: Date | null;
  readonly state: RegisteredDeviceRecord["state"];
  readonly updated_at: Date;
}

interface TemplateRow extends QueryResultRow {
  readonly archived_at: Date | null;
  readonly created_at: Date;
  readonly created_by_membership_id: string;
  readonly latest_version_number: number | string;
  readonly project_id: string;
  readonly published_at: Date | null;
  readonly published_version_number: number | string | null;
  readonly revision: number | string;
  readonly state: CloudTeamTemplateRecord["state"];
  readonly team_id: string;
  readonly template_id: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface TemplateVersionRow extends QueryResultRow {
  readonly author_account_id: string;
  readonly author_device_id: string;
  readonly author_membership_id: string;
  readonly cloned_from_template_id: string | null;
  readonly cloned_from_version_id: string | null;
  readonly created_at: Date;
  readonly payload_aad: unknown;
  readonly payload_algorithm: "AES-256-GCM";
  readonly payload_ciphertext: string;
  readonly payload_ciphertext_sha256: string;
  readonly payload_nonce: string;
  readonly project_id: string;
  readonly project_key_version: number;
  readonly team_id: string;
  readonly template_id: string;
  readonly tenant_id: string;
  readonly version_id: string;
  readonly version_number: number | string;
}

interface ApplicationRow extends QueryResultRow {
  readonly application_id: string;
  readonly applied_at: Date;
  readonly applied_by_account_id: string;
  readonly applied_by_membership_id: string;
  readonly project_id: string;
  readonly team_id: string;
  readonly template_id: string;
  readonly tenant_id: string;
  readonly version_id: string;
}

interface IdempotencyRow extends QueryResultRow {
  readonly actor_account_id: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly idempotency_key_hash_sha256: string;
  readonly operation_id: CloudIdempotencyRecord["operationId"];
  readonly request_hash_sha256: string;
  readonly response_snapshot: unknown;
  readonly response_status: number;
  readonly result_digest_sha256: string;
  readonly result_kind: IdempotencyResultKind;
  readonly result_resource_id: string | null;
  readonly scope_hash_sha256: string;
}

export class PostgresCloudTeamTemplateStore implements CloudTeamTemplateStore {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    operation: (transaction: CloudTeamTemplateTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresCloudTeamTemplateTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => {
        // Preserve the original database or domain error.
      });
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresCloudTeamTemplateTransaction implements CloudTeamTemplateTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async setPrincipal(accountId: string, deviceId: string): Promise<void> {
    await this.client.query(
      `SELECT
         set_config('inkshadow.account_id', $1, true),
         set_config('inkshadow.device_id', $2, true)`,
      [accountId, deviceId],
    );
  }

  public async setTeamScope(tenantId: string, teamId: string): Promise<void> {
    await this.client.query(
      `SELECT
         set_config('inkshadow.tenant_id', $1, true),
         set_config('inkshadow.team_id', $2, true)`,
      [tenantId, teamId],
    );
  }

  public async clearTeamScope(): Promise<void> {
    await this.client.query(
      `SELECT
         set_config('inkshadow.tenant_id', '', true),
         set_config('inkshadow.team_id', '', true)`,
    );
  }

  public async assertPrincipalActive(principal: CloudPrincipal, at: Date): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1
       FROM cloud_sessions AS session
       JOIN cloud_accounts AS account
         ON account.account_id = session.account_id
       JOIN registered_devices AS device
         ON device.device_id = session.device_id
       WHERE session.session_id = $1
         AND session.account_id = $2
         AND session.device_id = $3
         AND account.state = 'active'
         AND device.state = 'trusted'
         AND session.revoked_at IS NULL
         AND session.expires_at > $4
       FOR SHARE OF session, account, device`,
      [principal.sessionId, principal.accountId, principal.deviceId, at],
    );
    return result.rowCount === 1;
  }

  public async lockIdempotency(scopeHashSha256: string): Promise<void> {
    const signedLockId = BigInt.asIntN(64, BigInt(`0x${scopeHashSha256.slice(0, 16)}`));
    await this.client.query("SELECT pg_advisory_xact_lock($1::bigint)", [signedLockId.toString()]);
  }

  public async findIdempotency(scopeHashSha256: string): Promise<CloudIdempotencyRecord | null> {
    const result = await this.client.query<IdempotencyRow>(
      `SELECT *
       FROM cloud_idempotency_records
       WHERE scope_hash_sha256 = $1`,
      [scopeHashSha256],
    );
    return mapNullable(result.rows[0], mapIdempotency);
  }

  public async insertIdempotency(record: CloudIdempotencyRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_idempotency_records (
         scope_hash_sha256,
         actor_account_id,
         operation_id,
         idempotency_key_hash_sha256,
         request_hash_sha256,
         response_snapshot,
         result_kind,
         result_resource_id,
         result_digest_sha256,
         response_status,
         created_at,
         expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
      [
        record.scopeHashSha256,
        record.actorAccountId,
        record.operationId,
        record.idempotencyKeyHashSha256,
        record.requestHashSha256,
        JSON.stringify(record.responseSnapshot),
        record.resultKind,
        record.resultResourceId,
        record.resultDigestSha256,
        record.responseStatus,
        record.createdAt,
        record.expiresAt,
      ],
    );
  }

  public async findActiveMembershipForAccount(
    accountId: string,
    teamId: string,
  ): Promise<CloudTeamMembershipRecord | null> {
    const result = await this.client.query<MembershipRow>(
      `SELECT *
       FROM cloud_team_memberships
       WHERE account_id = $1
         AND team_id = $2
         AND state = 'active'`,
      [accountId, teamId],
    );
    return mapNullable(result.rows[0], mapMembership);
  }

  public async findTeam(
    tenantId: string,
    teamId: string,
    forUpdate = false,
  ): Promise<CloudTeamRecord | null> {
    const result = await this.client.query<TeamRow>(
      `SELECT *
       FROM cloud_teams
       WHERE tenant_id = $1
         AND team_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId],
    );
    return mapNullable(result.rows[0], mapTeam);
  }

  public async findMembership(
    tenantId: string,
    teamId: string,
    membershipId: string,
    forUpdate = false,
  ): Promise<CloudTeamMembershipRecord | null> {
    const result = await this.client.query<MembershipRow>(
      `SELECT *
       FROM cloud_team_memberships
       WHERE tenant_id = $1
         AND team_id = $2
         AND membership_id = $3${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId, membershipId],
    );
    return mapNullable(result.rows[0], mapMembership);
  }

  public async findProject(
    tenantId: string,
    projectId: string,
    forUpdate = false,
  ): Promise<CloudProjectRecord | null> {
    const result = await this.client.query<ProjectRow>(
      `SELECT *
       FROM cloud_projects
       WHERE tenant_id = $1
         AND project_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, projectId],
    );
    return mapNullable(result.rows[0], mapProject);
  }

  public async findAssignment(
    tenantId: string,
    teamId: string,
    projectId: string,
    membershipId: string,
    forUpdate = false,
  ): Promise<CloudProjectAssignmentRecord | null> {
    const result = await this.client.query<AssignmentRow>(
      `SELECT *
       FROM cloud_project_assignments
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND membership_id = $4${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId, projectId, membershipId],
    );
    return mapNullable(result.rows[0], mapAssignment);
  }

  public async findProjectKeyVersion(
    tenantId: string,
    projectId: string,
    keyVersion: number,
    forUpdate = false,
  ): Promise<CloudTeamProjectKeyVersionRecord | null> {
    const result = await this.client.query<ProjectKeyRow>(
      `SELECT
         tenant_id,
         project_id,
         key_version,
         server_revision,
         state,
         updated_at
       FROM project_key_versions
       WHERE tenant_id = $1
         AND project_id = $2
         AND key_version = $3${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, projectId, keyVersion],
    );
    return mapNullable(result.rows[0], mapProjectKey);
  }

  public async findDevice(
    deviceId: string,
    forUpdate = false,
  ): Promise<RegisteredDeviceRecord | null> {
    const result = await this.client.query<DeviceRow>(
      `SELECT *
       FROM registered_devices
       WHERE device_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [deviceId],
    );
    return mapNullable(result.rows[0], mapDevice);
  }

  public async insertTemplate(record: CloudTeamTemplateRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_team_templates (
         tenant_id,
         team_id,
         project_id,
         template_id,
         state,
         revision,
         latest_version_number,
         published_version_number,
         created_by_membership_id,
         created_at,
         updated_at,
         published_at,
         archived_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       )`,
      templateValues(record),
    );
  }

  public async findTemplate(
    tenantId: string,
    teamId: string,
    projectId: string,
    templateId: string,
    forUpdate = false,
  ): Promise<CloudTeamTemplateRecord | null> {
    const result = await this.client.query<TemplateRow>(
      `SELECT *
       FROM cloud_team_templates
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND template_id = $4${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId, projectId, templateId],
    );
    return mapNullable(result.rows[0], mapTemplate);
  }

  public async listTemplates(
    tenantId: string,
    teamId: string,
    projectId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudTeamTemplateRecord[]> {
    const result = await this.client.query<TemplateRow>(
      `SELECT *
       FROM cloud_team_templates
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND (
           $4::timestamptz IS NULL
           OR (created_at, template_id) < ($4::timestamptz, $5::uuid)
         )
       ORDER BY created_at DESC, template_id DESC
       LIMIT $6`,
      [tenantId, teamId, projectId, anchor?.createdAt ?? null, anchor?.id ?? null, limit],
    );
    return result.rows.map(mapTemplate);
  }

  public async updateTemplateCas(
    record: CloudTeamTemplateRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_team_templates
       SET state = $5,
           revision = $6,
           latest_version_number = $7,
           published_version_number = $8,
           updated_at = $9,
           published_at = $10,
           archived_at = $11
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND template_id = $4
         AND revision = $12`,
      [
        record.tenantId,
        record.teamId,
        record.projectId,
        record.templateId,
        record.state,
        record.revision,
        record.latestVersionNumber,
        record.publishedVersionNumber,
        record.updatedAt,
        record.publishedAt,
        record.archivedAt,
        expectedRevision,
      ],
    );
    return result.rowCount === 1;
  }

  public async insertVersion(record: CloudTeamTemplateVersionRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_team_template_versions (
         tenant_id,
         team_id,
         project_id,
         template_id,
         version_id,
         version_number,
         project_key_version,
         payload_algorithm,
         payload_nonce,
         payload_ciphertext,
         payload_ciphertext_sha256,
         payload_aad,
         author_membership_id,
         author_account_id,
         author_device_id,
         cloned_from_template_id,
         cloned_from_version_id,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18
       )`,
      versionValues(record),
    );
  }

  public async findVersion(
    tenantId: string,
    teamId: string,
    projectId: string,
    templateId: string,
    versionId: string,
  ): Promise<CloudTeamTemplateVersionRecord | null> {
    const result = await this.client.query<TemplateVersionRow>(
      `SELECT *
       FROM cloud_team_template_versions
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND template_id = $4
         AND version_id = $5`,
      [tenantId, teamId, projectId, templateId, versionId],
    );
    return mapNullable(result.rows[0], mapVersion);
  }

  public async findVersionByNumber(
    tenantId: string,
    teamId: string,
    projectId: string,
    templateId: string,
    versionNumber: number,
  ): Promise<CloudTeamTemplateVersionRecord | null> {
    const result = await this.client.query<TemplateVersionRow>(
      `SELECT *
       FROM cloud_team_template_versions
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND template_id = $4
         AND version_number = $5`,
      [tenantId, teamId, projectId, templateId, versionNumber],
    );
    return mapNullable(result.rows[0], mapVersion);
  }

  public async listVersions(
    tenantId: string,
    teamId: string,
    projectId: string,
    templateId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudTeamTemplateVersionRecord[]> {
    const result = await this.client.query<TemplateVersionRow>(
      `SELECT *
       FROM cloud_team_template_versions
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND template_id = $4
         AND (
           $5::timestamptz IS NULL
           OR (created_at, version_id) < ($5::timestamptz, $6::uuid)
         )
       ORDER BY created_at DESC, version_id DESC
       LIMIT $7`,
      [
        tenantId,
        teamId,
        projectId,
        templateId,
        anchor?.createdAt ?? null,
        anchor?.id ?? null,
        limit,
      ],
    );
    return result.rows.map(mapVersion);
  }

  public async insertApplication(record: CloudTeamTemplateApplicationRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_team_template_applications (
         tenant_id,
         team_id,
         project_id,
         template_id,
         version_id,
         application_id,
         applied_by_membership_id,
         applied_by_account_id,
         applied_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.tenantId,
        record.teamId,
        record.projectId,
        record.templateId,
        record.versionId,
        record.applicationId,
        record.appliedByMembershipId,
        record.appliedByAccountId,
        record.appliedAt,
      ],
    );
  }

  public async findApplication(
    tenantId: string,
    teamId: string,
    projectId: string,
    applicationId: string,
  ): Promise<CloudTeamTemplateApplicationRecord | null> {
    const result = await this.client.query<ApplicationRow>(
      `SELECT *
       FROM cloud_team_template_applications
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND application_id = $4`,
      [tenantId, teamId, projectId, applicationId],
    );
    return mapNullable(result.rows[0], mapApplication);
  }

  public async insertAuditEvent(record: CloudTeamAuditEventRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_team_audit_events (
         tenant_id,
         team_id,
         event_id,
         request_id,
         actor_account_id,
         actor_membership_id,
         resource_type,
         resource_id,
         action,
         result,
         reason,
         redacted_diff,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12::jsonb, $13
       )`,
      [
        record.tenantId,
        record.teamId,
        record.eventId,
        record.requestId,
        record.actorAccountId,
        record.actorMembershipId,
        record.resourceType,
        record.resourceId,
        record.action,
        record.result,
        record.reason,
        JSON.stringify(record.redactedDiff),
        record.createdAt,
      ],
    );
  }
}

function templateValues(record: CloudTeamTemplateRecord): unknown[] {
  return [
    record.tenantId,
    record.teamId,
    record.projectId,
    record.templateId,
    record.state,
    record.revision,
    record.latestVersionNumber,
    record.publishedVersionNumber,
    record.createdByMembershipId,
    record.createdAt,
    record.updatedAt,
    record.publishedAt,
    record.archivedAt,
  ];
}

function versionValues(record: CloudTeamTemplateVersionRecord): unknown[] {
  return [
    record.tenantId,
    record.teamId,
    record.projectId,
    record.templateId,
    record.versionId,
    record.versionNumber,
    record.projectKeyVersion,
    record.payload.algorithm,
    record.payload.nonce,
    record.payload.ciphertext,
    record.payload.ciphertextSha256,
    JSON.stringify(record.payload.aad),
    record.authorMembershipId,
    record.authorAccountId,
    record.authorDeviceId,
    record.clonedFromTemplateId,
    record.clonedFromVersionId,
    record.createdAt,
  ];
}

function mapMembership(row: MembershipRow): CloudTeamMembershipRecord {
  return {
    accountId: row.account_id,
    createdAt: row.created_at,
    membershipId: row.membership_id,
    revision: portableNumber(row.revision, "membership revision"),
    revokedAt: row.revoked_at,
    role: row.role,
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  };
}

function mapTeam(row: TeamRow): CloudTeamRecord {
  return {
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    displayName: row.display_name,
    revision: portableNumber(row.revision, "team revision"),
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  };
}

function mapProject(row: ProjectRow): CloudProjectRecord {
  return {
    createdAt: row.created_at,
    currentKeyVersion: row.current_key_version,
    deletionScheduledFor: row.deletion_scheduled_for,
    minimumAvailableRemoteSequence: BigInt(row.minimum_available_remote_sequence),
    ownerAccountId: row.owner_account_id,
    projectId: row.project_id,
    revision: portableNumber(row.revision, "project revision"),
    state: row.state,
    syncCompactionEpoch: BigInt(row.sync_compaction_epoch),
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  };
}

function mapAssignment(row: AssignmentRow): CloudProjectAssignmentRecord {
  return {
    assignmentId: row.assignment_id,
    createdAt: row.created_at,
    grantedByMembershipId: row.granted_by_membership_id,
    membershipId: row.membership_id,
    projectId: row.project_id,
    revision: portableNumber(row.revision, "assignment revision"),
    revokedAt: row.revoked_at,
    revokedByMembershipId: row.revoked_by_membership_id,
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  };
}

function mapProjectKey(row: ProjectKeyRow): CloudTeamProjectKeyVersionRecord {
  return {
    keyVersion: row.key_version,
    projectId: row.project_id,
    serverRevision: portableNumber(row.server_revision, "project-key server revision"),
    state: row.state,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  };
}

function mapDevice(row: DeviceRow): RegisteredDeviceRecord {
  return {
    accountId: row.account_id,
    algorithm: row.algorithm,
    clientVersion: row.client_version,
    createdAt: row.created_at,
    deviceId: row.device_id,
    displayName: row.display_name,
    publicKey: row.public_key,
    publicKeyFingerprint: row.public_key_fingerprint,
    revision: portableNumber(row.revision, "registered device revision"),
    revokedAt: row.revoked_at,
    state: row.state,
    updatedAt: row.updated_at,
  };
}

function mapTemplate(row: TemplateRow): CloudTeamTemplateRecord {
  return {
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    createdByMembershipId: row.created_by_membership_id,
    latestVersionNumber: portableNumber(
      row.latest_version_number,
      "template latest version number",
    ),
    projectId: row.project_id,
    publishedAt: row.published_at,
    publishedVersionNumber:
      row.published_version_number === null
        ? null
        : portableNumber(row.published_version_number, "template published version number"),
    revision: portableNumber(row.revision, "template revision"),
    state: row.state,
    teamId: row.team_id,
    templateId: row.template_id,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: TemplateVersionRow): CloudTeamTemplateVersionRecord {
  const aad = row.payload_aad as CloudTeamTemplateAad;
  const payload = CloudTeamTemplateCiphertextEnvelopeSchema.parse({
    aad,
    algorithm: row.payload_algorithm,
    ciphertext: row.payload_ciphertext,
    ciphertextSha256: row.payload_ciphertext_sha256,
    nonce: row.payload_nonce,
  });
  return {
    authorAccountId: row.author_account_id,
    authorDeviceId: row.author_device_id,
    authorMembershipId: row.author_membership_id,
    clonedFromTemplateId: row.cloned_from_template_id,
    clonedFromVersionId: row.cloned_from_version_id,
    createdAt: row.created_at,
    payload,
    projectId: row.project_id,
    projectKeyVersion: row.project_key_version,
    teamId: row.team_id,
    templateId: row.template_id,
    tenantId: row.tenant_id,
    versionId: row.version_id,
    versionNumber: portableNumber(row.version_number, "template version number"),
  };
}

function mapApplication(row: ApplicationRow): CloudTeamTemplateApplicationRecord {
  return {
    applicationId: row.application_id,
    appliedAt: row.applied_at,
    appliedByAccountId: row.applied_by_account_id,
    appliedByMembershipId: row.applied_by_membership_id,
    projectId: row.project_id,
    teamId: row.team_id,
    templateId: row.template_id,
    tenantId: row.tenant_id,
    versionId: row.version_id,
  };
}

function mapIdempotency(row: IdempotencyRow): CloudIdempotencyRecord {
  return {
    actorAccountId: row.actor_account_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    idempotencyKeyHashSha256: row.idempotency_key_hash_sha256,
    operationId: row.operation_id,
    requestHashSha256: row.request_hash_sha256,
    responseSnapshot: row.response_snapshot,
    responseStatus: row.response_status,
    resultDigestSha256: row.result_digest_sha256,
    resultKind: row.result_kind,
    resultResourceId: row.result_resource_id,
    scopeHashSha256: row.scope_hash_sha256,
  };
}

function mapNullable<Row, Output>(
  row: Row | undefined,
  mapper: (value: Row) => Output,
): Output | null {
  return row === undefined ? null : mapper(row);
}

function portableNumber(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`The database returned an invalid ${label}.`);
  }
  return parsed;
}
