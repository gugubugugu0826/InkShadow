import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { CloudProjectAccessRecord, CloudProjectRecord } from "../domain/project-records.js";
import type {
  CloudIdempotencyRecord,
  CloudPageAnchor,
  IdempotencyResultKind,
  RegisteredDeviceRecord,
} from "../domain/records.js";
import type { TeamInvitationOutboxRecord } from "../domain/team-invitation-outbox-record.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamAuditEventRecord,
  CloudTeamInvitationRecord,
  CloudTeamMembershipRecord,
  CloudTeamProjectKeyEnvelopeRecord,
  CloudTeamProjectKeyVersionRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type {
  CloudTeamProjectKeyRecipientCandidate,
  CloudTeamStore,
  CloudTeamTransaction,
} from "../repository/team-store.js";
import type { CloudPrincipal } from "../service/identity-service.js";
import { insertTeamInvitationOutbox } from "./team-invitation-outbox-store.js";

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

interface InvitationRow extends QueryResultRow {
  readonly accepted_at: Date | null;
  readonly accepted_membership_id: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly invitation_id: string;
  readonly invited_by_membership_id: string;
  readonly invitee_email: string;
  readonly revision: number | string;
  readonly revoked_at: Date | null;
  readonly role: CloudTeamInvitationRecord["role"];
  readonly state: CloudTeamInvitationRecord["state"];
  readonly team_id: string;
  readonly tenant_id: string;
  readonly token_hash_sha256: string;
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

interface ProjectAccessRow extends QueryResultRow {
  readonly account_id: string;
  readonly can_manage_keys: boolean;
  readonly can_sync: boolean;
  readonly created_at: Date;
  readonly project_id: string;
  readonly revision: number | string;
  readonly revoked_at: Date | null;
  readonly role: CloudProjectAccessRecord["role"];
  readonly tenant_id: string;
}

interface TeamProjectKeyVersionRow extends QueryResultRow {
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

interface TeamProjectKeyRecipientCandidateRow extends QueryResultRow {
  readonly assignment_assignment_id: string;
  readonly assignment_created_at: Date;
  readonly assignment_granted_by_membership_id: string;
  readonly assignment_membership_id: string;
  readonly assignment_project_id: string;
  readonly assignment_revision: number | string;
  readonly assignment_revoked_at: Date | null;
  readonly assignment_revoked_by_membership_id: string | null;
  readonly assignment_state: CloudProjectAssignmentRecord["state"];
  readonly assignment_team_id: string;
  readonly assignment_tenant_id: string;
  readonly assignment_updated_at: Date;
  readonly device_account_id: string;
  readonly device_algorithm: RegisteredDeviceRecord["algorithm"];
  readonly device_client_version: string;
  readonly device_created_at: Date;
  readonly device_device_id: string;
  readonly device_display_name: string;
  readonly device_public_key: string;
  readonly device_public_key_fingerprint: string;
  readonly device_revision: number | string;
  readonly device_revoked_at: Date | null;
  readonly device_state: RegisteredDeviceRecord["state"];
  readonly device_updated_at: Date;
  readonly membership_account_id: string;
  readonly membership_created_at: Date;
  readonly membership_membership_id: string;
  readonly membership_revision: number | string;
  readonly membership_revoked_at: Date | null;
  readonly membership_role: CloudTeamMembershipRecord["role"];
  readonly membership_state: CloudTeamMembershipRecord["state"];
  readonly membership_team_id: string;
  readonly membership_tenant_id: string;
  readonly membership_updated_at: Date;
}

interface TeamProjectKeyEnvelopeRow extends QueryResultRow {
  readonly algorithm: CloudTeamProjectKeyEnvelopeRecord["algorithm"];
  readonly assignment_id: string;
  readonly assignment_revision: number | string;
  readonly ciphertext: string;
  readonly created_at: Date;
  readonly encapsulated_key: string;
  readonly envelope_id: string;
  readonly invalidated_at: Date | null;
  readonly invalidation_reason: CloudTeamProjectKeyEnvelopeRecord["invalidationReason"];
  readonly key_version: number;
  readonly membership_id: string;
  readonly membership_revision: number | string;
  readonly project_id: string;
  readonly recipient_account_id: string;
  readonly recipient_device_id: string;
  readonly recipient_device_revision: number | string;
  readonly recipient_public_key: string;
  readonly recipient_public_key_fingerprint: string;
  readonly sender_account_id: string;
  readonly sender_device_id: string;
  readonly sender_device_revision: number | string;
  readonly sender_membership_id: string;
  readonly sender_membership_revision: number | string;
  readonly sender_public_key: string;
  readonly sender_public_key_fingerprint: string;
  readonly server_revision: number | string;
  readonly team_id: string;
  readonly tenant_id: string;
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

export class PostgresCloudTeamStore implements CloudTeamStore {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    operation: (transaction: CloudTeamTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresCloudTeamTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresCloudTeamTransaction implements CloudTeamTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async setPrincipal(accountId: string, deviceId?: string): Promise<void> {
    await this.client.query(
      `SELECT
         set_config('inkshadow.account_id', $1, true),
         set_config('inkshadow.device_id', $2, true)`,
      [accountId, deviceId ?? ""],
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

  public async findActiveAccountEmail(accountId: string): Promise<string | null> {
    const result = await this.client.query<{ email_canonical: string }>(
      `SELECT email_canonical
       FROM cloud_accounts
       WHERE account_id = $1
         AND state = 'active'`,
      [accountId],
    );
    return result.rows[0]?.email_canonical ?? null;
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

  public async insertTeam(record: CloudTeamRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_teams (
         tenant_id,
         team_id,
         display_name,
         state,
         revision,
         created_at,
         updated_at,
         archived_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.tenantId,
        record.teamId,
        record.displayName,
        record.state,
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.archivedAt,
      ],
    );
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

  public lockTeam(tenantId: string, teamId: string): Promise<CloudTeamRecord | null> {
    return this.findTeam(tenantId, teamId, true);
  }

  public async insertMembership(record: CloudTeamMembershipRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_team_memberships (
         tenant_id,
         team_id,
         membership_id,
         account_id,
         role,
         state,
         revision,
         created_at,
         updated_at,
         revoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        record.tenantId,
        record.teamId,
        record.membershipId,
        record.accountId,
        record.role,
        record.state,
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.revokedAt,
      ],
    );
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

  public async findActiveMembershipForAccount(
    accountId: string,
    teamId: string,
    forUpdate = false,
  ): Promise<CloudTeamMembershipRecord | null> {
    const result = await this.client.query<MembershipRow>(
      `SELECT *
       FROM cloud_team_memberships
       WHERE account_id = $1
         AND team_id = $2
         AND state = 'active'${forUpdate ? " FOR UPDATE" : ""}`,
      [accountId, teamId],
    );
    return mapNullable(result.rows[0], mapMembership);
  }

  public async listActiveMembershipsForAccount(
    accountId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudTeamMembershipRecord[]> {
    const result = await this.client.query<MembershipRow>(
      `SELECT *
       FROM cloud_team_memberships
       WHERE account_id = $1
         AND state = 'active'
         AND (
           $3::timestamptz IS NULL
           OR (created_at, membership_id) < ($3::timestamptz, $4::uuid)
         )
       ORDER BY created_at DESC, membership_id DESC
       LIMIT $2`,
      [accountId, limit, anchor?.createdAt ?? null, anchor?.id ?? null],
    );
    return result.rows.map(mapMembership);
  }

  public async listMemberships(
    tenantId: string,
    teamId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudTeamMembershipRecord[]> {
    const result = await this.client.query<MembershipRow>(
      `SELECT *
       FROM cloud_team_memberships
       WHERE tenant_id = $1
         AND team_id = $2
         AND (
           $4::timestamptz IS NULL
           OR (created_at, membership_id) < ($4::timestamptz, $5::uuid)
         )
       ORDER BY created_at DESC, membership_id DESC
       LIMIT $3`,
      [tenantId, teamId, limit, anchor?.createdAt ?? null, anchor?.id ?? null],
    );
    return result.rows.map(mapMembership);
  }

  public async hasActiveMembershipForEmail(
    tenantId: string,
    teamId: string,
    emailCanonical: string,
  ): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1
       FROM cloud_team_memberships AS membership
       JOIN cloud_accounts AS account
         ON account.account_id = membership.account_id
       WHERE membership.tenant_id = $1
         AND membership.team_id = $2
         AND membership.state = 'active'
         AND account.email_canonical = $3`,
      [tenantId, teamId, emailCanonical],
    );
    return result.rowCount === 1;
  }

  public async listActiveProjectIdsForMembership(
    tenantId: string,
    teamId: string,
    membershipId: string,
  ): Promise<readonly string[]> {
    const result = await this.client.query<{ project_id: string }>(
      `SELECT project_id
       FROM cloud_project_assignments
       WHERE tenant_id = $1
         AND team_id = $2
         AND membership_id = $3
         AND state = 'active'
       ORDER BY project_id`,
      [tenantId, teamId, membershipId],
    );
    return result.rows.map((row) => row.project_id);
  }

  public async lockActiveOwners(
    tenantId: string,
    teamId: string,
  ): Promise<readonly CloudTeamMembershipRecord[]> {
    const result = await this.client.query<MembershipRow>(
      `SELECT *
       FROM cloud_team_memberships
       WHERE tenant_id = $1
         AND team_id = $2
         AND state = 'active'
         AND role = 'owner'
       ORDER BY membership_id
       FOR UPDATE`,
      [tenantId, teamId],
    );
    return result.rows.map(mapMembership);
  }

  public async updateMembershipCas(
    record: CloudTeamMembershipRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_team_memberships
       SET role = $5,
           state = $6,
           revision = $7,
           updated_at = $8,
           revoked_at = $9
       WHERE tenant_id = $1
         AND team_id = $2
         AND membership_id = $3
         AND revision = $4`,
      [
        record.tenantId,
        record.teamId,
        record.membershipId,
        expectedRevision,
        record.role,
        record.state,
        record.revision,
        record.updatedAt,
        record.revokedAt,
      ],
    );
    return result.rowCount === 1;
  }

  public async insertInvitation(record: CloudTeamInvitationRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_team_invitations (
         tenant_id,
         team_id,
         invitation_id,
         invitee_email,
         role,
         state,
         token_hash_sha256,
         revision,
         invited_by_membership_id,
         accepted_membership_id,
         created_at,
         updated_at,
         expires_at,
         accepted_at,
         revoked_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
       )`,
      [
        record.tenantId,
        record.teamId,
        record.invitationId,
        record.inviteeEmail,
        record.role,
        record.state,
        record.tokenHashSha256,
        record.revision,
        record.invitedByMembershipId,
        record.acceptedMembershipId,
        record.createdAt,
        record.updatedAt,
        record.expiresAt,
        record.acceptedAt,
        record.revokedAt,
      ],
    );
  }

  public insertInvitationOutbox(record: TeamInvitationOutboxRecord): Promise<void> {
    return insertTeamInvitationOutbox(this.client, record);
  }

  public async cancelInvitationOutbox(
    tenantId: string,
    teamId: string,
    invitationId: string,
    at: Date,
    errorCode: string,
  ): Promise<boolean> {
    const result = await this.client.query<{ changed: boolean }>(
      `SELECT inkshadow_terminalize_team_invitation_outbox(
         $1, $2, $3, $4, $5
       ) AS changed`,
      [tenantId, teamId, invitationId, at, errorCode],
    );
    return result.rows[0]?.changed === true;
  }

  public async expirePendingInvitations(
    tenantId: string,
    teamId: string,
    inviteeEmail: string,
    at: Date,
  ): Promise<number> {
    const result = await this.client.query<{ invitation_id: string }>(
      `UPDATE cloud_team_invitations
       SET state = 'expired',
           revision = revision + 1,
           updated_at = $4
       WHERE tenant_id = $1
         AND team_id = $2
         AND invitee_email = $3
         AND state = 'pending'
         AND expires_at <= $4
       RETURNING invitation_id`,
      [tenantId, teamId, inviteeEmail, at],
    );
    for (const row of result.rows) {
      await this.cancelInvitationOutbox(
        tenantId,
        teamId,
        row.invitation_id,
        at,
        "INVITATION_EXPIRED",
      );
    }
    return result.rows.length;
  }

  public async findInvitationForInvitee(
    invitationId: string,
    forUpdate = false,
  ): Promise<CloudTeamInvitationRecord | null> {
    const result = await this.client.query<InvitationRow>(
      `SELECT *
       FROM cloud_team_invitations
       WHERE invitation_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [invitationId],
    );
    return mapNullable(result.rows[0], mapInvitation);
  }

  public async updateInvitationCas(
    record: CloudTeamInvitationRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_team_invitations
       SET state = $5,
           revision = $6,
           accepted_membership_id = $7,
           updated_at = $8,
           accepted_at = $9,
           revoked_at = $10
       WHERE tenant_id = $1
         AND team_id = $2
         AND invitation_id = $3
         AND revision = $4`,
      [
        record.tenantId,
        record.teamId,
        record.invitationId,
        expectedRevision,
        record.state,
        record.revision,
        record.acceptedMembershipId,
        record.updatedAt,
        record.acceptedAt,
        record.revokedAt,
      ],
    );
    return result.rowCount === 1;
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

  public async findProjectAccess(
    tenantId: string,
    projectId: string,
    accountId: string,
    forUpdate = false,
  ): Promise<CloudProjectAccessRecord | null> {
    const result = await this.client.query<ProjectAccessRow>(
      `SELECT *
       FROM cloud_project_access
       WHERE tenant_id = $1
         AND project_id = $2
         AND account_id = $3${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, projectId, accountId],
    );
    return mapNullable(result.rows[0], mapProjectAccess);
  }

  public async findProjectKeyVersion(
    tenantId: string,
    projectId: string,
    keyVersion: number,
    forUpdate = false,
  ): Promise<CloudTeamProjectKeyVersionRecord | null> {
    const result = await this.client.query<TeamProjectKeyVersionRow>(
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
    return mapNullable(result.rows[0], mapTeamProjectKeyVersion);
  }

  public async findCurrentProjectKeyVersion(
    tenantId: string,
    projectId: string,
  ): Promise<CloudTeamProjectKeyVersionRecord | null> {
    const result = await this.client.query<TeamProjectKeyVersionRow>(
      `SELECT
         key_record.tenant_id,
         key_record.project_id,
         key_record.key_version,
         key_record.server_revision,
         key_record.state,
         key_record.updated_at
       FROM cloud_projects AS project
       JOIN project_key_versions AS key_record
         ON key_record.tenant_id = project.tenant_id
         AND key_record.project_id = project.project_id
         AND key_record.key_version = project.current_key_version
       WHERE project.tenant_id = $1
         AND project.project_id = $2
         AND project.state = 'active'
         AND key_record.state = 'active'`,
      [tenantId, projectId],
    );
    return mapNullable(result.rows[0], mapTeamProjectKeyVersion);
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

  public async hasActivePersonalDeviceEnvelope(
    tenantId: string,
    projectId: string,
    keyVersion: number,
    recipientDeviceId: string,
  ): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1
       FROM device_project_key_envelopes
       WHERE tenant_id = $1
         AND project_id = $2
         AND key_version = $3
         AND recipient_device_id = $4
         AND revoked_at IS NULL`,
      [tenantId, projectId, keyVersion, recipientDeviceId],
    );
    return result.rowCount === 1;
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

  public async listAssignments(
    tenantId: string,
    teamId: string,
    projectId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudProjectAssignmentRecord[]> {
    const result = await this.client.query<AssignmentRow>(
      `SELECT *
       FROM cloud_project_assignments
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND (
           $5::timestamptz IS NULL
           OR (created_at, assignment_id) < ($5::timestamptz, $6::uuid)
         )
       ORDER BY created_at DESC, assignment_id DESC
       LIMIT $4`,
      [tenantId, teamId, projectId, limit, anchor?.createdAt ?? null, anchor?.id ?? null],
    );
    return result.rows.map(mapAssignment);
  }

  public async insertAssignment(record: CloudProjectAssignmentRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_project_assignments (
         tenant_id,
         team_id,
         project_id,
         membership_id,
         assignment_id,
         state,
         revision,
         granted_by_membership_id,
         revoked_by_membership_id,
         created_at,
         updated_at,
         revoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.tenantId,
        record.teamId,
        record.projectId,
        record.membershipId,
        record.assignmentId,
        record.state,
        record.revision,
        record.grantedByMembershipId,
        record.revokedByMembershipId,
        record.createdAt,
        record.updatedAt,
        record.revokedAt,
      ],
    );
  }

  public async updateAssignmentCas(
    record: CloudProjectAssignmentRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_project_assignments
       SET state = $6,
           revision = $7,
           granted_by_membership_id = $8,
           revoked_by_membership_id = $9,
           updated_at = $10,
           revoked_at = $11
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND membership_id = $4
         AND revision = $5`,
      [
        record.tenantId,
        record.teamId,
        record.projectId,
        record.membershipId,
        expectedRevision,
        record.state,
        record.revision,
        record.grantedByMembershipId,
        record.revokedByMembershipId,
        record.updatedAt,
        record.revokedAt,
      ],
    );
    return result.rowCount === 1;
  }

  public async revokeActiveAssignmentsForMembership(
    tenantId: string,
    teamId: string,
    membershipId: string,
    actorMembershipId: string,
    at: Date,
  ): Promise<number> {
    const result = await this.client.query(
      `UPDATE cloud_project_assignments
       SET state = 'revoked',
           revision = revision + 1,
           revoked_by_membership_id = $4,
           updated_at = $5,
           revoked_at = $5
       WHERE tenant_id = $1
         AND team_id = $2
         AND membership_id = $3
         AND state = 'active'`,
      [tenantId, teamId, membershipId, actorMembershipId, at],
    );
    return result.rowCount ?? 0;
  }

  public async listActiveTeamProjectKeyRecipientCandidates(
    tenantId: string,
    teamId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly CloudTeamProjectKeyRecipientCandidate[]> {
    const result = await this.client.query<TeamProjectKeyRecipientCandidateRow>(
      `SELECT
         assignment.assignment_id AS assignment_assignment_id,
         assignment.created_at AS assignment_created_at,
         assignment.granted_by_membership_id AS assignment_granted_by_membership_id,
         assignment.membership_id AS assignment_membership_id,
         assignment.project_id AS assignment_project_id,
         assignment.revision AS assignment_revision,
         assignment.revoked_at AS assignment_revoked_at,
         assignment.revoked_by_membership_id AS assignment_revoked_by_membership_id,
         assignment.state AS assignment_state,
         assignment.team_id AS assignment_team_id,
         assignment.tenant_id AS assignment_tenant_id,
         assignment.updated_at AS assignment_updated_at,
         membership.account_id AS membership_account_id,
         membership.created_at AS membership_created_at,
         membership.membership_id AS membership_membership_id,
         membership.revision AS membership_revision,
         membership.revoked_at AS membership_revoked_at,
         membership.role AS membership_role,
         membership.state AS membership_state,
         membership.team_id AS membership_team_id,
         membership.tenant_id AS membership_tenant_id,
         membership.updated_at AS membership_updated_at,
         device.account_id AS device_account_id,
         device.algorithm AS device_algorithm,
         device.client_version AS device_client_version,
         device.created_at AS device_created_at,
         device.device_id AS device_device_id,
         device.display_name AS device_display_name,
         device.public_key AS device_public_key,
         device.public_key_fingerprint AS device_public_key_fingerprint,
         device.revision AS device_revision,
         device.revoked_at AS device_revoked_at,
         device.state AS device_state,
         device.updated_at AS device_updated_at
       FROM cloud_project_assignments AS assignment
       JOIN cloud_team_memberships AS membership
         ON membership.tenant_id = assignment.tenant_id
         AND membership.team_id = assignment.team_id
         AND membership.membership_id = assignment.membership_id
       JOIN cloud_accounts AS account
         ON account.account_id = membership.account_id
       JOIN registered_devices AS device
         ON device.account_id = membership.account_id
       WHERE assignment.tenant_id = $1
         AND assignment.team_id = $2
         AND assignment.project_id = $3
         AND assignment.state = 'active'
         AND membership.state = 'active'
         AND account.state = 'active'
         AND device.state = 'trusted'
       ORDER BY
         membership.membership_id,
         device.created_at,
         device.device_id
       LIMIT $4`,
      [tenantId, teamId, projectId, limit],
    );
    return result.rows.map(mapTeamProjectKeyRecipientCandidate);
  }

  public async findActiveTeamProjectKeyEnvelope(
    tenantId: string,
    teamId: string,
    projectId: string,
    keyVersion: number,
    recipientDeviceId: string,
  ): Promise<CloudTeamProjectKeyEnvelopeRecord | null> {
    const result = await this.client.query<TeamProjectKeyEnvelopeRow>(
      `SELECT *
       FROM cloud_team_project_key_envelopes
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND key_version = $4
         AND recipient_device_id = $5
         AND invalidated_at IS NULL`,
      [tenantId, teamId, projectId, keyVersion, recipientDeviceId],
    );
    return mapNullable(result.rows[0], mapTeamProjectKeyEnvelope);
  }

  public async hasActiveTeamProjectKeyEnvelope(
    tenantId: string,
    teamId: string,
    projectId: string,
    keyVersion: number,
    recipientDeviceId: string,
  ): Promise<boolean> {
    const result = await this.client.query<{ envelope_exists: boolean }>(
      `SELECT inkshadow_active_team_project_key_envelope_exists(
         $1,
         $2,
         $3,
         $4,
         $5
       ) AS envelope_exists`,
      [tenantId, teamId, projectId, keyVersion, recipientDeviceId],
    );
    return result.rows[0]?.envelope_exists === true;
  }

  public async hasCurrentPrincipalTeamProjectKeyEnvelope(
    tenantId: string,
    teamId: string,
    projectId: string,
    keyVersion: number,
  ): Promise<boolean> {
    const result = await this.client.query<{ envelope_exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM cloud_team_project_key_envelopes AS envelope
         JOIN cloud_team_memberships AS membership
           ON membership.tenant_id = envelope.tenant_id
           AND membership.team_id = envelope.team_id
           AND membership.membership_id = envelope.membership_id
         JOIN cloud_project_assignments AS assignment
           ON assignment.tenant_id = envelope.tenant_id
           AND assignment.team_id = envelope.team_id
           AND assignment.project_id = envelope.project_id
           AND assignment.membership_id = envelope.membership_id
           AND assignment.assignment_id = envelope.assignment_id
         JOIN registered_devices AS device
           ON device.account_id = envelope.recipient_account_id
           AND device.device_id = envelope.recipient_device_id
         WHERE envelope.tenant_id = $1
           AND envelope.team_id = $2
           AND envelope.project_id = $3
           AND envelope.key_version = $4
           AND envelope.recipient_account_id = inkshadow_current_account()
           AND envelope.recipient_device_id = inkshadow_current_device()
           AND envelope.invalidated_at IS NULL
           AND membership.account_id = envelope.recipient_account_id
           AND membership.state = 'active'
           AND membership.revision = envelope.membership_revision
           AND assignment.state = 'active'
           AND assignment.revision = envelope.assignment_revision
           AND device.state = 'trusted'
           AND device.revoked_at IS NULL
           AND device.revision = envelope.recipient_device_revision
           AND device.public_key = envelope.recipient_public_key
           AND device.public_key_fingerprint = envelope.recipient_public_key_fingerprint
       ) AS envelope_exists`,
      [tenantId, teamId, projectId, keyVersion],
    );
    return result.rows[0]?.envelope_exists === true;
  }

  public async findTeamProjectKeyEnvelopeById(
    tenantId: string,
    teamId: string,
    envelopeId: string,
  ): Promise<CloudTeamProjectKeyEnvelopeRecord | null> {
    const result = await this.client.query<TeamProjectKeyEnvelopeRow>(
      `SELECT *
       FROM cloud_team_project_key_envelopes
       WHERE tenant_id = $1
         AND team_id = $2
         AND envelope_id = $3`,
      [tenantId, teamId, envelopeId],
    );
    return mapNullable(result.rows[0], mapTeamProjectKeyEnvelope);
  }

  public async insertTeamProjectKeyEnvelope(
    record: CloudTeamProjectKeyEnvelopeRecord,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_team_project_key_envelopes (
         tenant_id,
         team_id,
         project_id,
         key_version,
         envelope_id,
         membership_id,
         membership_revision,
         assignment_id,
         assignment_revision,
         sender_account_id,
         sender_membership_id,
         sender_membership_revision,
         sender_device_id,
         sender_device_revision,
         sender_public_key,
         sender_public_key_fingerprint,
         recipient_account_id,
         recipient_device_id,
         recipient_device_revision,
         recipient_public_key,
         recipient_public_key_fingerprint,
         algorithm,
         encapsulated_key,
         ciphertext,
         server_revision,
         created_at,
         invalidated_at,
         invalidation_reason
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27,
         $28
       )`,
      [
        record.tenantId,
        record.teamId,
        record.projectId,
        record.keyVersion,
        record.envelopeId,
        record.membershipId,
        record.membershipRevision,
        record.assignmentId,
        record.assignmentRevision,
        record.senderAccountId,
        record.senderMembershipId,
        record.senderMembershipRevision,
        record.senderDeviceId,
        record.senderDeviceRevision,
        record.senderPublicKey,
        record.senderPublicKeyFingerprint,
        record.recipientAccountId,
        record.recipientDeviceId,
        record.recipientDeviceRevision,
        record.recipientPublicKey,
        record.recipientPublicKeyFingerprint,
        record.algorithm,
        record.encapsulatedKey,
        record.ciphertext,
        record.serverRevision,
        record.createdAt,
        record.invalidatedAt,
        record.invalidationReason,
      ],
    );
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
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13
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

function mapTeam(row: TeamRow): CloudTeamRecord {
  return {
    archivedAt: nullableDate(row.archived_at, "team archived_at"),
    createdAt: requireDate(row.created_at, "team created_at"),
    displayName: row.display_name,
    revision: requireSafeInteger(row.revision, "team revision"),
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "team updated_at"),
  };
}

function mapMembership(row: MembershipRow): CloudTeamMembershipRecord {
  return {
    accountId: row.account_id,
    createdAt: requireDate(row.created_at, "membership created_at"),
    membershipId: row.membership_id,
    revision: requireSafeInteger(row.revision, "membership revision"),
    revokedAt: nullableDate(row.revoked_at, "membership revoked_at"),
    role: row.role,
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "membership updated_at"),
  };
}

function mapInvitation(row: InvitationRow): CloudTeamInvitationRecord {
  return {
    acceptedAt: nullableDate(row.accepted_at, "invitation accepted_at"),
    acceptedMembershipId: row.accepted_membership_id,
    createdAt: requireDate(row.created_at, "invitation created_at"),
    expiresAt: requireDate(row.expires_at, "invitation expires_at"),
    invitationId: row.invitation_id,
    invitedByMembershipId: row.invited_by_membership_id,
    inviteeEmail: row.invitee_email,
    revision: requireSafeInteger(row.revision, "invitation revision"),
    revokedAt: nullableDate(row.revoked_at, "invitation revoked_at"),
    role: row.role,
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    tokenHashSha256: row.token_hash_sha256,
    updatedAt: requireDate(row.updated_at, "invitation updated_at"),
  };
}

function mapAssignment(row: AssignmentRow): CloudProjectAssignmentRecord {
  return {
    assignmentId: row.assignment_id,
    createdAt: requireDate(row.created_at, "assignment created_at"),
    grantedByMembershipId: row.granted_by_membership_id,
    membershipId: row.membership_id,
    projectId: row.project_id,
    revision: requireSafeInteger(row.revision, "assignment revision"),
    revokedAt: nullableDate(row.revoked_at, "assignment revoked_at"),
    revokedByMembershipId: row.revoked_by_membership_id,
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "assignment updated_at"),
  };
}

function mapProjectAccess(row: ProjectAccessRow): CloudProjectAccessRecord {
  return {
    accountId: row.account_id,
    canManageKeys: row.can_manage_keys,
    canSync: row.can_sync,
    createdAt: requireDate(row.created_at, "project access created_at"),
    projectId: row.project_id,
    revision: requireSafeInteger(row.revision, "project access revision"),
    revokedAt: nullableDate(row.revoked_at, "project access revoked_at"),
    role: row.role,
    tenantId: row.tenant_id,
  };
}

function mapTeamProjectKeyVersion(row: TeamProjectKeyVersionRow): CloudTeamProjectKeyVersionRecord {
  return {
    keyVersion: row.key_version,
    projectId: row.project_id,
    serverRevision: requireSafeInteger(row.server_revision, "project key server revision"),
    state: row.state,
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "project key updated_at"),
  };
}

function mapDevice(row: DeviceRow): RegisteredDeviceRecord {
  return {
    accountId: row.account_id,
    algorithm: row.algorithm,
    clientVersion: row.client_version,
    createdAt: requireDate(row.created_at, "registered device created_at"),
    deviceId: row.device_id,
    displayName: row.display_name,
    publicKey: row.public_key,
    publicKeyFingerprint: row.public_key_fingerprint,
    revision: requireSafeInteger(row.revision, "registered device revision"),
    revokedAt: nullableDate(row.revoked_at, "registered device revoked_at"),
    state: row.state,
    updatedAt: requireDate(row.updated_at, "registered device updated_at"),
  };
}

function mapTeamProjectKeyRecipientCandidate(
  row: TeamProjectKeyRecipientCandidateRow,
): CloudTeamProjectKeyRecipientCandidate {
  return {
    assignment: {
      assignmentId: row.assignment_assignment_id,
      createdAt: requireDate(row.assignment_created_at, "assignment created_at"),
      grantedByMembershipId: row.assignment_granted_by_membership_id,
      membershipId: row.assignment_membership_id,
      projectId: row.assignment_project_id,
      revision: requireSafeInteger(row.assignment_revision, "assignment revision"),
      revokedAt: nullableDate(row.assignment_revoked_at, "assignment revoked_at"),
      revokedByMembershipId: row.assignment_revoked_by_membership_id,
      state: row.assignment_state,
      teamId: row.assignment_team_id,
      tenantId: row.assignment_tenant_id,
      updatedAt: requireDate(row.assignment_updated_at, "assignment updated_at"),
    },
    device: {
      accountId: row.device_account_id,
      algorithm: row.device_algorithm,
      clientVersion: row.device_client_version,
      createdAt: requireDate(row.device_created_at, "registered device created_at"),
      deviceId: row.device_device_id,
      displayName: row.device_display_name,
      publicKey: row.device_public_key,
      publicKeyFingerprint: row.device_public_key_fingerprint,
      revision: requireSafeInteger(row.device_revision, "registered device revision"),
      revokedAt: nullableDate(row.device_revoked_at, "registered device revoked_at"),
      state: row.device_state,
      updatedAt: requireDate(row.device_updated_at, "registered device updated_at"),
    },
    membership: {
      accountId: row.membership_account_id,
      createdAt: requireDate(row.membership_created_at, "membership created_at"),
      membershipId: row.membership_membership_id,
      revision: requireSafeInteger(row.membership_revision, "membership revision"),
      revokedAt: nullableDate(row.membership_revoked_at, "membership revoked_at"),
      role: row.membership_role,
      state: row.membership_state,
      teamId: row.membership_team_id,
      tenantId: row.membership_tenant_id,
      updatedAt: requireDate(row.membership_updated_at, "membership updated_at"),
    },
  };
}

function mapTeamProjectKeyEnvelope(
  row: TeamProjectKeyEnvelopeRow,
): CloudTeamProjectKeyEnvelopeRecord {
  return {
    algorithm: row.algorithm,
    assignmentId: row.assignment_id,
    assignmentRevision: requireSafeInteger(
      row.assignment_revision,
      "team envelope assignment revision",
    ),
    ciphertext: row.ciphertext,
    createdAt: requireDate(row.created_at, "team envelope created_at"),
    encapsulatedKey: row.encapsulated_key,
    envelopeId: row.envelope_id,
    invalidatedAt: nullableDate(row.invalidated_at, "team envelope invalidated_at"),
    invalidationReason: row.invalidation_reason,
    keyVersion: row.key_version,
    membershipId: row.membership_id,
    membershipRevision: requireSafeInteger(
      row.membership_revision,
      "team envelope membership revision",
    ),
    projectId: row.project_id,
    recipientAccountId: row.recipient_account_id,
    recipientDeviceId: row.recipient_device_id,
    recipientDeviceRevision: requireSafeInteger(
      row.recipient_device_revision,
      "team envelope recipient device revision",
    ),
    recipientPublicKey: row.recipient_public_key,
    recipientPublicKeyFingerprint: row.recipient_public_key_fingerprint,
    senderAccountId: row.sender_account_id,
    senderDeviceId: row.sender_device_id,
    senderDeviceRevision: requireSafeInteger(
      row.sender_device_revision,
      "team envelope sender device revision",
    ),
    senderMembershipId: row.sender_membership_id,
    senderMembershipRevision: requireSafeInteger(
      row.sender_membership_revision,
      "team envelope sender membership revision",
    ),
    senderPublicKey: row.sender_public_key,
    senderPublicKeyFingerprint: row.sender_public_key_fingerprint,
    serverRevision: requireSafeInteger(row.server_revision, "team envelope server revision"),
    teamId: row.team_id,
    tenantId: row.tenant_id,
  };
}

function mapProject(row: ProjectRow): CloudProjectRecord {
  return {
    createdAt: requireDate(row.created_at, "project created_at"),
    currentKeyVersion: row.current_key_version,
    deletionScheduledFor: nullableDate(
      row.deletion_scheduled_for,
      "project deletion_scheduled_for",
    ),
    minimumAvailableRemoteSequence: BigInt(row.minimum_available_remote_sequence),
    ownerAccountId: row.owner_account_id,
    projectId: row.project_id,
    revision: requireSafeInteger(row.revision, "project revision"),
    state: row.state,
    syncCompactionEpoch: BigInt(row.sync_compaction_epoch),
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "project updated_at"),
  };
}

function mapIdempotency(row: IdempotencyRow): CloudIdempotencyRecord {
  return {
    actorAccountId: row.actor_account_id,
    createdAt: requireDate(row.created_at, "idempotency created_at"),
    expiresAt: requireDate(row.expires_at, "idempotency expires_at"),
    idempotencyKeyHashSha256: row.idempotency_key_hash_sha256,
    operationId: row.operation_id,
    requestHashSha256: row.request_hash_sha256,
    responseSnapshot: row.response_snapshot,
    responseStatus: requireSafeInteger(row.response_status, "idempotency response_status"),
    resultDigestSha256: row.result_digest_sha256,
    resultKind: row.result_kind,
    resultResourceId: row.result_resource_id,
    scopeHashSha256: row.scope_hash_sha256,
  };
}

function mapNullable<Row, Value>(
  row: Row | undefined,
  mapper: (value: Row) => Value,
): Value | null {
  return row === undefined ? null : mapper(row);
}

function requireSafeInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL returned an unsafe ${label}.`);
  }
  return parsed;
}

function requireDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }
  return value;
}

function nullableDate(value: Date | null, label: string): Date | null {
  return value === null ? null : requireDate(value, label);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transactional failure.
  }
}
