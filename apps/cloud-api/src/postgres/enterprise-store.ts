import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { CloudIdempotencyRecord, RegisteredDeviceRecord } from "../domain/records.js";
import type {
  CloudEnterpriseMemberRecord,
  CloudEnterpriseOidcBindingRecord,
  CloudEnterpriseOidcFlowRecord,
  CloudEnterprisePolicyRecord,
  CloudEnterprisePublicSsoPolicyRecord,
} from "../domain/enterprise-records.js";
import type {
  CloudTeamAuditEventRecord,
  CloudTeamMembershipRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type {
  CloudEnterpriseStore,
  CloudEnterpriseTransaction,
} from "../repository/enterprise-store.js";
import type { CloudPrincipal } from "../service/identity-service.js";

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

interface PolicyRow extends QueryResultRow {
  readonly allowed_email_domains: string[];
  readonly allowed_external_hosts: string[];
  readonly approved_device_fingerprints: string[];
  readonly created_at: Date;
  readonly created_by_membership_id: string;
  readonly device_approval_mode: CloudEnterprisePolicyRecord["deviceApprovalMode"];
  readonly export_mode: CloudEnterprisePolicyRecord["exportMode"];
  readonly external_egress_mode: CloudEnterprisePolicyRecord["externalEgressMode"];
  readonly maximum_trusted_devices: number | string;
  readonly revision: number | string;
  readonly session_maximum_minutes: number | string;
  readonly sso_mode: CloudEnterprisePolicyRecord["ssoMode"];
  readonly support_bundle_mode: CloudEnterprisePolicyRecord["supportBundleMode"];
  readonly team_id: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
  readonly updated_by_membership_id: string;
}

interface PublicSsoPolicyRow extends QueryResultRow {
  readonly allowed_email_domains: string[];
  readonly approved_device_fingerprints: string[];
  readonly device_approval_mode: CloudEnterprisePolicyRecord["deviceApprovalMode"];
  readonly maximum_trusted_devices: number | string;
  readonly revision: number | string;
  readonly session_maximum_minutes: number | string;
  readonly sso_mode: CloudEnterprisePolicyRecord["ssoMode"];
  readonly team_id: string;
  readonly tenant_id: string;
}

interface OidcFlowRow extends QueryResultRow {
  readonly attempt_count: number | string;
  readonly consumed_at: Date | null;
  readonly created_at: Date;
  readonly device_binding_hash_sha256: string;
  readonly exchange_claim_id: string | null;
  readonly exchange_started_at: Date | null;
  readonly expires_at: Date;
  readonly flow_id: string;
  readonly flow_secret_hash_sha256: string;
  readonly completion_idempotency_key_hash_sha256: string | null;
  readonly maximum_trusted_devices: number | string;
  readonly policy_revision: number | string;
  readonly redirect_uri: string;
  readonly state_hash_sha256: string;
  readonly subject_hash_sha256: string | null;
  readonly team_id: string;
  readonly tenant_id: string;
  readonly verified_account_id: string | null;
  readonly verified_membership_id: string | null;
  readonly session_maximum_minutes: number | string;
}

interface OidcBindingRow extends QueryResultRow {
  readonly account_id: string;
  readonly created_at: Date;
  readonly issuer_hash_sha256: string;
  readonly last_authenticated_at: Date;
  readonly membership_id: string;
  readonly subject_hash_sha256: string;
  readonly team_id: string;
  readonly tenant_id: string;
}

interface MemberRow extends QueryResultRow {
  readonly account_id: string;
  readonly membership_id: string;
  readonly role: CloudEnterpriseMemberRecord["role"];
  readonly team_id: string;
  readonly tenant_id: string;
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

interface IdempotencyRow extends QueryResultRow {
  readonly actor_account_id: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly idempotency_key_hash_sha256: string;
  readonly operation_id: CloudIdempotencyRecord["operationId"];
  readonly request_hash_sha256: string;
  readonly response_snapshot: unknown;
  readonly response_status: number | string;
  readonly result_digest_sha256: string;
  readonly result_kind: CloudIdempotencyRecord["resultKind"];
  readonly result_resource_id: string | null;
  readonly scope_hash_sha256: string;
}

export class PostgresCloudEnterpriseStore implements CloudEnterpriseStore {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    operation: (transaction: CloudEnterpriseTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresCloudEnterpriseTransaction(client));
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

class PostgresCloudEnterpriseTransaction implements CloudEnterpriseTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async setPrincipal(accountId: string, deviceId?: string): Promise<void> {
    await this.client.query(
      `SELECT
         set_config('inkshadow.account_id', $1, true),
         set_config('inkshadow.device_id', $2, true)`,
      [accountId, deviceId ?? ""],
    );
  }

  public async clearTeamScope(): Promise<void> {
    await this.client.query(
      `SELECT
         set_config('inkshadow.tenant_id', '', true),
         set_config('inkshadow.team_id', '', true)`,
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

  public async countTrustedDevices(accountId: string): Promise<number> {
    const result = await this.client.query<{ count: number | string }>(
      `SELECT count(*) AS count
       FROM registered_devices
       WHERE account_id = $1
         AND state = 'trusted'`,
      [accountId],
    );
    return requirePortableInteger(result.rows[0]?.count ?? -1, "trusted device count");
  }

  public async findTrustedDevice(
    accountId: string,
    deviceId: string,
  ): Promise<RegisteredDeviceRecord | null> {
    const result = await this.client.query<DeviceRow>(
      `SELECT *
       FROM registered_devices
       WHERE account_id = $1
         AND device_id = $2
         AND state = 'trusted'`,
      [accountId, deviceId],
    );
    return mapNullable(result.rows[0], mapDevice);
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

  public async findPolicy(
    tenantId: string,
    teamId: string,
    forUpdate = false,
  ): Promise<CloudEnterprisePolicyRecord | null> {
    const result = await this.client.query<PolicyRow>(
      `SELECT *
       FROM cloud_enterprise_policies
       WHERE tenant_id = $1
         AND team_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId],
    );
    return mapNullable(result.rows[0], mapPolicy);
  }

  public async insertPolicy(record: CloudEnterprisePolicyRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_enterprise_policies (
         tenant_id,
         team_id,
         revision,
         sso_mode,
         allowed_email_domains,
         session_maximum_minutes,
         maximum_trusted_devices,
         device_approval_mode,
         approved_device_fingerprints,
         export_mode,
         external_egress_mode,
         allowed_external_hosts,
         support_bundle_mode,
         created_by_membership_id,
         updated_by_membership_id,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5::text[], $6, $7, $8, $9::text[], $10, $11,
         $12::text[], $13, $14, $15, $16, $17
       )`,
      policyParameters(record),
    );
  }

  public async updatePolicyCas(
    record: CloudEnterprisePolicyRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const parameters = policyParameters(record);
    const result = await this.client.query(
      `UPDATE cloud_enterprise_policies
       SET revision = $3,
           sso_mode = $4,
           allowed_email_domains = $5::text[],
           session_maximum_minutes = $6,
           maximum_trusted_devices = $7,
           device_approval_mode = $8,
           approved_device_fingerprints = $9::text[],
           export_mode = $10,
           external_egress_mode = $11,
           allowed_external_hosts = $12::text[],
           support_bundle_mode = $13,
           updated_by_membership_id = $15,
           updated_at = $17
       WHERE tenant_id = $1
         AND team_id = $2
         AND revision = $18`,
      [...parameters, expectedRevision],
    );
    return result.rowCount === 1;
  }

  public async findPublicSsoPolicy(
    teamId: string,
  ): Promise<CloudEnterprisePublicSsoPolicyRecord | null> {
    const result = await this.client.query<PublicSsoPolicyRow>(
      `SELECT *
       FROM inkshadow_enterprise_public_sso_policy($1)`,
      [teamId],
    );
    return mapNullable(result.rows[0], mapPublicSsoPolicy);
  }

  public async findRequiredSsoTeams(
    accountId: string,
  ): Promise<readonly { tenantId: string; teamId: string }[]> {
    const result = await this.client.query<{ tenant_id: string; team_id: string }>(
      `SELECT *
       FROM inkshadow_enterprise_required_sso_teams($1)`,
      [accountId],
    );
    return result.rows.map((row) => ({ teamId: row.team_id, tenantId: row.tenant_id }));
  }

  public async insertOidcFlow(record: CloudEnterpriseOidcFlowRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_enterprise_oidc_flows (
         tenant_id,
         team_id,
         flow_id,
         policy_revision,
         session_maximum_minutes,
         maximum_trusted_devices,
         flow_secret_hash_sha256,
         state_hash_sha256,
         redirect_uri,
         device_binding_hash_sha256,
         exchange_claim_id,
         exchange_started_at,
         attempt_count,
         verified_account_id,
         verified_membership_id,
         subject_hash_sha256,
         completion_idempotency_key_hash_sha256,
         expires_at,
         consumed_at,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20
       )`,
      oidcFlowParameters(record),
    );
  }

  public async resolveOidcFlowScope(
    flowId: string,
  ): Promise<{ readonly tenantId: string; readonly teamId: string } | null> {
    const result = await this.client.query<{ tenant_id: string; team_id: string }>(
      `SELECT *
       FROM inkshadow_enterprise_resolve_flow($1)`,
      [flowId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { teamId: row.team_id, tenantId: row.tenant_id };
  }

  public async findOidcFlow(
    tenantId: string,
    teamId: string,
    flowId: string,
    forUpdate = false,
  ): Promise<CloudEnterpriseOidcFlowRecord | null> {
    const result = await this.client.query<OidcFlowRow>(
      `SELECT *
       FROM cloud_enterprise_oidc_flows
       WHERE tenant_id = $1
         AND team_id = $2
         AND flow_id = $3${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId, flowId],
    );
    return mapNullable(result.rows[0], mapOidcFlow);
  }

  public async updateOidcFlow(record: CloudEnterpriseOidcFlowRecord): Promise<void> {
    const result = await this.client.query(
      `UPDATE cloud_enterprise_oidc_flows
       SET policy_revision = $4,
           session_maximum_minutes = $5,
           maximum_trusted_devices = $6,
           flow_secret_hash_sha256 = $7,
           state_hash_sha256 = $8,
           redirect_uri = $9,
           device_binding_hash_sha256 = $10,
           exchange_claim_id = $11,
           exchange_started_at = $12,
           attempt_count = $13,
           verified_account_id = $14,
           verified_membership_id = $15,
           subject_hash_sha256 = $16,
           completion_idempotency_key_hash_sha256 = $17,
           expires_at = $18,
           consumed_at = $19
       WHERE tenant_id = $1
         AND team_id = $2
         AND flow_id = $3`,
      oidcFlowParameters(record).slice(0, 19),
    );
    requireAffectedRow(result.rowCount, "Enterprise OIDC flow");
  }

  public async resolveMember(
    teamId: string,
    emailCanonical: string,
  ): Promise<CloudEnterpriseMemberRecord | null> {
    const result = await this.client.query<MemberRow>(
      `SELECT *
       FROM inkshadow_enterprise_resolve_member($1, $2)`,
      [teamId, emailCanonical],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          accountId: row.account_id,
          membershipId: row.membership_id,
          role: row.role,
          teamId: row.team_id,
          tenantId: row.tenant_id,
        };
  }

  public async findOidcBinding(
    tenantId: string,
    teamId: string,
    issuerHashSha256: string,
    subjectHashSha256: string,
    forUpdate = false,
  ): Promise<CloudEnterpriseOidcBindingRecord | null> {
    const result = await this.client.query<OidcBindingRow>(
      `SELECT *
       FROM cloud_enterprise_oidc_bindings
       WHERE tenant_id = $1
         AND team_id = $2
         AND issuer_hash_sha256 = $3
         AND subject_hash_sha256 = $4${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId, issuerHashSha256, subjectHashSha256],
    );
    return mapNullable(result.rows[0], mapOidcBinding);
  }

  public async findOidcBindingForAccount(
    tenantId: string,
    teamId: string,
    issuerHashSha256: string,
    accountId: string,
    forUpdate = false,
  ): Promise<CloudEnterpriseOidcBindingRecord | null> {
    const result = await this.client.query<OidcBindingRow>(
      `SELECT *
       FROM cloud_enterprise_oidc_bindings
       WHERE tenant_id = $1
         AND team_id = $2
         AND issuer_hash_sha256 = $3
         AND account_id = $4${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId, issuerHashSha256, accountId],
    );
    return mapNullable(result.rows[0], mapOidcBinding);
  }

  public async insertOidcBinding(record: CloudEnterpriseOidcBindingRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_enterprise_oidc_bindings (
         tenant_id,
         team_id,
         issuer_hash_sha256,
         subject_hash_sha256,
         account_id,
         membership_id,
         created_at,
         last_authenticated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      oidcBindingParameters(record),
    );
  }

  public async updateOidcBinding(record: CloudEnterpriseOidcBindingRecord): Promise<void> {
    const result = await this.client.query(
      `UPDATE cloud_enterprise_oidc_bindings
       SET membership_id = $6,
           last_authenticated_at = $8
       WHERE tenant_id = $1
         AND team_id = $2
         AND issuer_hash_sha256 = $3
         AND subject_hash_sha256 = $4
         AND account_id = $5`,
      oidcBindingParameters(record),
    );
    requireAffectedRow(result.rowCount, "Enterprise OIDC binding");
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
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
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

function policyParameters(record: CloudEnterprisePolicyRecord): unknown[] {
  return [
    record.tenantId,
    record.teamId,
    record.revision,
    record.ssoMode,
    [...record.allowedEmailDomains],
    record.sessionMaximumMinutes,
    record.maximumTrustedDevices,
    record.deviceApprovalMode,
    [...record.approvedDeviceFingerprints],
    record.exportMode,
    record.externalEgressMode,
    [...record.allowedExternalHosts],
    record.supportBundleMode,
    record.createdByMembershipId,
    record.updatedByMembershipId,
    record.createdAt,
    record.updatedAt,
  ];
}

function oidcFlowParameters(record: CloudEnterpriseOidcFlowRecord): unknown[] {
  return [
    record.tenantId,
    record.teamId,
    record.flowId,
    record.policyRevision,
    record.sessionMaximumMinutes,
    record.maximumTrustedDevices,
    record.flowSecretHashSha256,
    record.stateHashSha256,
    record.redirectUri,
    record.deviceBindingHashSha256,
    record.exchangeClaimId,
    record.exchangeStartedAt,
    record.attemptCount,
    record.verifiedAccountId,
    record.verifiedMembershipId,
    record.subjectHashSha256,
    record.completionIdempotencyKeyHashSha256,
    record.expiresAt,
    record.consumedAt,
    record.createdAt,
  ];
}

function oidcBindingParameters(record: CloudEnterpriseOidcBindingRecord): unknown[] {
  return [
    record.tenantId,
    record.teamId,
    record.issuerHashSha256,
    record.subjectHashSha256,
    record.accountId,
    record.membershipId,
    record.createdAt,
    record.lastAuthenticatedAt,
  ];
}

function mapTeam(row: TeamRow): CloudTeamRecord {
  return {
    archivedAt: nullableDate(row.archived_at, "team archived_at"),
    createdAt: requireDate(row.created_at, "team created_at"),
    displayName: row.display_name,
    revision: requirePortableInteger(row.revision, "team revision"),
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
    revision: requirePortableInteger(row.revision, "membership revision"),
    revokedAt: nullableDate(row.revoked_at, "membership revoked_at"),
    role: row.role,
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "membership updated_at"),
  };
}

function mapDevice(row: DeviceRow): RegisteredDeviceRecord {
  return {
    accountId: row.account_id,
    algorithm: row.algorithm,
    clientVersion: row.client_version,
    createdAt: requireDate(row.created_at, "device created_at"),
    deviceId: row.device_id,
    displayName: row.display_name,
    publicKey: row.public_key,
    publicKeyFingerprint: row.public_key_fingerprint,
    revision: requirePortableInteger(row.revision, "device revision"),
    revokedAt: nullableDate(row.revoked_at, "device revoked_at"),
    state: row.state,
    updatedAt: requireDate(row.updated_at, "device updated_at"),
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
    responseStatus: requirePortableInteger(row.response_status, "idempotency status"),
    resultDigestSha256: row.result_digest_sha256,
    resultKind: row.result_kind,
    resultResourceId: row.result_resource_id,
    scopeHashSha256: row.scope_hash_sha256,
  };
}

function mapPolicy(row: PolicyRow): CloudEnterprisePolicyRecord {
  return {
    allowedEmailDomains: Object.freeze([...row.allowed_email_domains]),
    allowedExternalHosts: Object.freeze([...row.allowed_external_hosts]),
    approvedDeviceFingerprints: Object.freeze([...row.approved_device_fingerprints]),
    createdAt: requireDate(row.created_at, "Enterprise policy created_at"),
    createdByMembershipId: row.created_by_membership_id,
    deviceApprovalMode: row.device_approval_mode,
    exportMode: row.export_mode,
    externalEgressMode: row.external_egress_mode,
    maximumTrustedDevices: requirePortableInteger(
      row.maximum_trusted_devices,
      "Enterprise maximum trusted devices",
    ),
    revision: requirePortableInteger(row.revision, "Enterprise policy revision"),
    sessionMaximumMinutes: requirePortableInteger(
      row.session_maximum_minutes,
      "Enterprise session maximum minutes",
    ),
    ssoMode: row.sso_mode,
    supportBundleMode: row.support_bundle_mode,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "Enterprise policy updated_at"),
    updatedByMembershipId: row.updated_by_membership_id,
  };
}

function mapPublicSsoPolicy(row: PublicSsoPolicyRow): CloudEnterprisePublicSsoPolicyRecord {
  return {
    allowedEmailDomains: Object.freeze([...row.allowed_email_domains]),
    approvedDeviceFingerprints: Object.freeze([...row.approved_device_fingerprints]),
    deviceApprovalMode: row.device_approval_mode,
    maximumTrustedDevices: requirePortableInteger(
      row.maximum_trusted_devices,
      "Enterprise maximum trusted devices",
    ),
    revision: requirePortableInteger(row.revision, "Enterprise policy revision"),
    sessionMaximumMinutes: requirePortableInteger(
      row.session_maximum_minutes,
      "Enterprise session maximum minutes",
    ),
    ssoMode: row.sso_mode,
    teamId: row.team_id,
    tenantId: row.tenant_id,
  };
}

function mapOidcFlow(row: OidcFlowRow): CloudEnterpriseOidcFlowRecord {
  return {
    attemptCount: requirePortableInteger(row.attempt_count, "OIDC flow attempt count"),
    completionIdempotencyKeyHashSha256: row.completion_idempotency_key_hash_sha256,
    consumedAt: nullableDate(row.consumed_at, "OIDC flow consumed_at"),
    createdAt: requireDate(row.created_at, "OIDC flow created_at"),
    deviceBindingHashSha256: row.device_binding_hash_sha256,
    exchangeClaimId: row.exchange_claim_id,
    exchangeStartedAt: nullableDate(row.exchange_started_at, "OIDC flow exchange_started_at"),
    expiresAt: requireDate(row.expires_at, "OIDC flow expires_at"),
    flowId: row.flow_id,
    flowSecretHashSha256: row.flow_secret_hash_sha256,
    maximumTrustedDevices: requirePortableInteger(
      row.maximum_trusted_devices,
      "OIDC flow maximum trusted devices",
    ),
    policyRevision: requirePortableInteger(row.policy_revision, "OIDC flow policy revision"),
    redirectUri: row.redirect_uri,
    sessionMaximumMinutes: requirePortableInteger(
      row.session_maximum_minutes,
      "OIDC flow session maximum minutes",
    ),
    stateHashSha256: row.state_hash_sha256,
    subjectHashSha256: row.subject_hash_sha256,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    verifiedAccountId: row.verified_account_id,
    verifiedMembershipId: row.verified_membership_id,
  };
}

function mapOidcBinding(row: OidcBindingRow): CloudEnterpriseOidcBindingRecord {
  return {
    accountId: row.account_id,
    createdAt: requireDate(row.created_at, "OIDC binding created_at"),
    issuerHashSha256: row.issuer_hash_sha256,
    lastAuthenticatedAt: requireDate(
      row.last_authenticated_at,
      "OIDC binding last_authenticated_at",
    ),
    membershipId: row.membership_id,
    subjectHashSha256: row.subject_hash_sha256,
    teamId: row.team_id,
    tenantId: row.tenant_id,
  };
}

function requirePortableInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
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

function mapNullable<Row, Value>(
  row: Row | undefined,
  mapper: (value: Row) => Value,
): Value | null {
  return row === undefined ? null : mapper(row);
}

function requireAffectedRow(rowCount: number | null, resource: string): void {
  if (rowCount !== 1) {
    throw new Error(`Expected exactly one ${resource} row to be updated.`);
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original transaction failure remains actionable.
  }
}
