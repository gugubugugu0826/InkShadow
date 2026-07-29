import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { CloudProjectRecord } from "../domain/project-records.js";
import type {
  CloudReviewRecord,
  CloudReviewThreadItemRecord,
  CloudReviewThreadRecord,
} from "../domain/review-records.js";
import type {
  CloudIdempotencyRecord,
  CloudPageAnchor,
  IdempotencyResultKind,
} from "../domain/records.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamAuditEventRecord,
  CloudTeamMembershipRecord,
  CloudTeamProjectKeyVersionRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type { CloudReviewStore, CloudReviewTransaction } from "../repository/review-store.js";
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

interface ReviewRow extends QueryResultRow {
  readonly created_at: Date;
  readonly decided_at: Date | null;
  readonly decision_by_membership_id: string | null;
  readonly payload_algorithm: CloudReviewRecord["payload"]["algorithm"];
  readonly payload_ciphertext: string;
  readonly payload_ciphertext_sha256: string;
  readonly payload_nonce: string;
  readonly project_id: string;
  readonly project_key_version: number;
  readonly review_id: string;
  readonly revision: number | string;
  readonly source_ciphertext_sha256: string;
  readonly source_version_id: string;
  readonly source_version_revision: number | string;
  readonly state: CloudReviewRecord["state"];
  readonly submitted_by_membership_id: string;
  readonly team_id: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface ThreadRow extends QueryResultRow {
  readonly created_at: Date;
  readonly created_by_membership_id: string;
  readonly item_count: number | string;
  readonly project_id: string;
  readonly resolved_at: Date | null;
  readonly resolved_by_membership_id: string | null;
  readonly review_id: string;
  readonly revision: number | string;
  readonly root_item_id: string;
  readonly state: CloudReviewThreadRecord["state"];
  readonly team_id: string;
  readonly tenant_id: string;
  readonly thread_id: string;
  readonly updated_at: Date;
}

interface ThreadItemRow extends QueryResultRow {
  readonly created_at: Date;
  readonly created_by_membership_id: string;
  readonly item_id: string;
  readonly item_type: CloudReviewThreadItemRecord["itemType"];
  readonly parent_item_id: string | null;
  readonly payload_algorithm: CloudReviewThreadItemRecord["payload"]["algorithm"];
  readonly payload_ciphertext: string;
  readonly payload_ciphertext_sha256: string;
  readonly payload_nonce: string;
  readonly project_id: string;
  readonly review_id: string;
  readonly revision: number | string;
  readonly suggestion_decided_at: Date | null;
  readonly suggestion_decided_by_membership_id: string | null;
  readonly suggestion_decision: CloudReviewThreadItemRecord["suggestionDecision"];
  readonly team_id: string;
  readonly tenant_id: string;
  readonly thread_id: string;
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
  readonly response_status: number;
  readonly result_digest_sha256: string;
  readonly result_kind: IdempotencyResultKind;
  readonly result_resource_id: string | null;
  readonly scope_hash_sha256: string;
}

export class PostgresCloudReviewStore implements CloudReviewStore {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    operation: (transaction: CloudReviewTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresCloudReviewTransaction(client));
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

class PostgresCloudReviewTransaction implements CloudReviewTransaction {
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
    return result.rows[0] === undefined ? null : mapIdempotency(result.rows[0]);
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

  public async findTeam(tenantId: string, teamId: string): Promise<CloudTeamRecord | null> {
    const result = await this.client.query<TeamRow>(
      `SELECT *
       FROM cloud_teams
       WHERE tenant_id = $1
         AND team_id = $2`,
      [tenantId, teamId],
    );
    return mapNullable(result.rows[0], mapTeam);
  }

  public async findMembership(
    tenantId: string,
    teamId: string,
    membershipId: string,
  ): Promise<CloudTeamMembershipRecord | null> {
    const result = await this.client.query<MembershipRow>(
      `SELECT *
       FROM cloud_team_memberships
       WHERE tenant_id = $1
         AND team_id = $2
         AND membership_id = $3`,
      [tenantId, teamId, membershipId],
    );
    return mapNullable(result.rows[0], mapMembership);
  }

  public async findProject(
    tenantId: string,
    projectId: string,
  ): Promise<CloudProjectRecord | null> {
    const result = await this.client.query<ProjectRow>(
      `SELECT *
       FROM cloud_projects
       WHERE tenant_id = $1
         AND project_id = $2`,
      [tenantId, projectId],
    );
    return mapNullable(result.rows[0], mapProject);
  }

  public async findAssignment(
    tenantId: string,
    teamId: string,
    projectId: string,
    membershipId: string,
  ): Promise<CloudProjectAssignmentRecord | null> {
    const result = await this.client.query<AssignmentRow>(
      `SELECT *
       FROM cloud_project_assignments
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND membership_id = $4`,
      [tenantId, teamId, projectId, membershipId],
    );
    return mapNullable(result.rows[0], mapAssignment);
  }

  public async findProjectKeyVersion(
    tenantId: string,
    projectId: string,
    keyVersion: number,
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
         AND key_version = $3`,
      [tenantId, projectId, keyVersion],
    );
    return mapNullable(result.rows[0], mapProjectKey);
  }

  public async insertReview(record: CloudReviewRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_review_submissions (
         tenant_id,
         team_id,
         project_id,
         review_id,
         source_version_id,
         source_version_revision,
         source_ciphertext_sha256,
         project_key_version,
         payload_algorithm,
         payload_nonce,
         payload_ciphertext,
         payload_ciphertext_sha256,
         submitted_by_membership_id,
         state,
         revision,
         decision_by_membership_id,
         decided_at,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19
       )`,
      reviewValues(record),
    );
  }

  public async findReview(
    tenantId: string,
    teamId: string,
    projectId: string,
    reviewId: string,
    forUpdate = false,
  ): Promise<CloudReviewRecord | null> {
    const result = await this.client.query<ReviewRow>(
      `SELECT *
       FROM cloud_review_submissions
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND review_id = $4
       ${forUpdate ? "FOR UPDATE" : ""}`,
      [tenantId, teamId, projectId, reviewId],
    );
    return mapNullable(result.rows[0], mapReview);
  }

  public async listReviews(
    tenantId: string,
    teamId: string,
    projectId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudReviewRecord[]> {
    const result = await this.client.query<ReviewRow>(
      `SELECT *
       FROM cloud_review_submissions
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND (
           $4::timestamptz IS NULL
           OR (created_at, review_id) < ($4::timestamptz, $5::uuid)
         )
       ORDER BY created_at DESC, review_id DESC
       LIMIT $6`,
      [tenantId, teamId, projectId, anchor?.createdAt ?? null, anchor?.id ?? null, limit],
    );
    return result.rows.map(mapReview);
  }

  public async updateReviewDecisionCas(
    record: CloudReviewRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_review_submissions
       SET
         state = $5,
         revision = $6,
         decision_by_membership_id = $7,
         decided_at = $8,
         updated_at = $9
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND review_id = $4
         AND revision = $10
         AND state = 'pending'`,
      [
        record.tenantId,
        record.teamId,
        record.projectId,
        record.reviewId,
        record.state,
        record.revision,
        record.decisionByMembershipId,
        record.decidedAt,
        record.updatedAt,
        expectedRevision,
      ],
    );
    return result.rowCount === 1;
  }

  public async insertThread(record: CloudReviewThreadRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_review_threads (
         tenant_id,
         team_id,
         project_id,
         review_id,
         thread_id,
         root_item_id,
         state,
         revision,
         item_count,
         created_by_membership_id,
         resolved_by_membership_id,
         resolved_at,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14
       )`,
      threadValues(record),
    );
  }

  public async findThread(
    tenantId: string,
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    forUpdate = false,
  ): Promise<CloudReviewThreadRecord | null> {
    const result = await this.client.query<ThreadRow>(
      `SELECT *
       FROM cloud_review_threads
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND review_id = $4
         AND thread_id = $5
       ${forUpdate ? "FOR UPDATE" : ""}`,
      [tenantId, teamId, projectId, reviewId, threadId],
    );
    return mapNullable(result.rows[0], mapThread);
  }

  public async listThreads(
    tenantId: string,
    teamId: string,
    projectId: string,
    reviewId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudReviewThreadRecord[]> {
    const result = await this.client.query<ThreadRow>(
      `SELECT *
       FROM cloud_review_threads
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND review_id = $4
         AND (
           $5::timestamptz IS NULL
           OR (created_at, thread_id) < ($5::timestamptz, $6::uuid)
         )
       ORDER BY created_at DESC, thread_id DESC
       LIMIT $7`,
      [tenantId, teamId, projectId, reviewId, anchor?.createdAt ?? null, anchor?.id ?? null, limit],
    );
    return result.rows.map(mapThread);
  }

  public async updateThreadCas(
    record: CloudReviewThreadRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_review_threads
       SET
         state = $6,
         revision = $7,
         item_count = $8,
         resolved_by_membership_id = $9,
         resolved_at = $10,
         updated_at = $11
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND review_id = $4
         AND thread_id = $5
         AND revision = $12
         AND state = 'open'`,
      [
        record.tenantId,
        record.teamId,
        record.projectId,
        record.reviewId,
        record.threadId,
        record.state,
        record.revision,
        record.itemCount,
        record.resolvedByMembershipId,
        record.resolvedAt,
        record.updatedAt,
        expectedRevision,
      ],
    );
    return result.rowCount === 1;
  }

  public async insertThreadItem(record: CloudReviewThreadItemRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_review_thread_items (
         tenant_id,
         team_id,
         project_id,
         review_id,
         thread_id,
         item_id,
         item_type,
         parent_item_id,
         payload_algorithm,
         payload_nonce,
         payload_ciphertext,
         payload_ciphertext_sha256,
         created_by_membership_id,
         revision,
         suggestion_decision,
         suggestion_decided_by_membership_id,
         suggestion_decided_at,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19
       )`,
      threadItemValues(record),
    );
  }

  public async findThreadItem(
    tenantId: string,
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    itemId: string,
    forUpdate = false,
  ): Promise<CloudReviewThreadItemRecord | null> {
    const result = await this.client.query<ThreadItemRow>(
      `SELECT *
       FROM cloud_review_thread_items
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND review_id = $4
         AND thread_id = $5
         AND item_id = $6
       ${forUpdate ? "FOR UPDATE" : ""}`,
      [tenantId, teamId, projectId, reviewId, threadId, itemId],
    );
    return mapNullable(result.rows[0], mapThreadItem);
  }

  public async listThreadItems(
    tenantId: string,
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudReviewThreadItemRecord[]> {
    const result = await this.client.query<ThreadItemRow>(
      `SELECT *
       FROM cloud_review_thread_items
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND review_id = $4
         AND thread_id = $5
         AND (
           $6::timestamptz IS NULL
           OR (created_at, item_id) > ($6::timestamptz, $7::uuid)
         )
       ORDER BY created_at, item_id
       LIMIT $8`,
      [
        tenantId,
        teamId,
        projectId,
        reviewId,
        threadId,
        anchor?.createdAt ?? null,
        anchor?.id ?? null,
        limit,
      ],
    );
    return result.rows.map(mapThreadItem);
  }

  public async updateSuggestionDecisionCas(
    record: CloudReviewThreadItemRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_review_thread_items
       SET
         revision = $7,
         suggestion_decision = $8,
         suggestion_decided_by_membership_id = $9,
         suggestion_decided_at = $10,
         updated_at = $11
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND review_id = $4
         AND thread_id = $5
         AND item_id = $6
         AND revision = $12
         AND item_type = 'suggestion'
         AND suggestion_decision = 'pending'`,
      [
        record.tenantId,
        record.teamId,
        record.projectId,
        record.reviewId,
        record.threadId,
        record.itemId,
        record.revision,
        record.suggestionDecision,
        record.suggestionDecidedByMembershipId,
        record.suggestionDecidedAt,
        record.updatedAt,
        expectedRevision,
      ],
    );
    return result.rowCount === 1;
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

function reviewValues(record: CloudReviewRecord): unknown[] {
  return [
    record.tenantId,
    record.teamId,
    record.projectId,
    record.reviewId,
    record.sourceVersionId,
    record.sourceVersionRevision,
    record.sourceCiphertextSha256,
    record.projectKeyVersion,
    record.payload.algorithm,
    record.payload.nonce,
    record.payload.ciphertext,
    record.payload.ciphertextSha256,
    record.submittedByMembershipId,
    record.state,
    record.revision,
    record.decisionByMembershipId,
    record.decidedAt,
    record.createdAt,
    record.updatedAt,
  ];
}

function threadValues(record: CloudReviewThreadRecord): unknown[] {
  return [
    record.tenantId,
    record.teamId,
    record.projectId,
    record.reviewId,
    record.threadId,
    record.rootItemId,
    record.state,
    record.revision,
    record.itemCount,
    record.createdByMembershipId,
    record.resolvedByMembershipId,
    record.resolvedAt,
    record.createdAt,
    record.updatedAt,
  ];
}

function threadItemValues(record: CloudReviewThreadItemRecord): unknown[] {
  return [
    record.tenantId,
    record.teamId,
    record.projectId,
    record.reviewId,
    record.threadId,
    record.itemId,
    record.itemType,
    record.parentItemId,
    record.payload.algorithm,
    record.payload.nonce,
    record.payload.ciphertext,
    record.payload.ciphertextSha256,
    record.createdByMembershipId,
    record.revision,
    record.suggestionDecision,
    record.suggestionDecidedByMembershipId,
    record.suggestionDecidedAt,
    record.createdAt,
    record.updatedAt,
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

function mapReview(row: ReviewRow): CloudReviewRecord {
  return {
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decisionByMembershipId: row.decision_by_membership_id,
    payload: {
      algorithm: row.payload_algorithm,
      ciphertext: row.payload_ciphertext,
      ciphertextSha256: row.payload_ciphertext_sha256,
      nonce: row.payload_nonce,
    },
    projectId: row.project_id,
    projectKeyVersion: row.project_key_version,
    reviewId: row.review_id,
    revision: portableNumber(row.revision, "review revision"),
    sourceCiphertextSha256: row.source_ciphertext_sha256,
    sourceVersionId: row.source_version_id,
    sourceVersionRevision: portableNumber(row.source_version_revision, "source version revision"),
    state: row.state,
    submittedByMembershipId: row.submitted_by_membership_id,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  };
}

function mapThread(row: ThreadRow): CloudReviewThreadRecord {
  return {
    createdAt: row.created_at,
    createdByMembershipId: row.created_by_membership_id,
    itemCount: portableNumber(row.item_count, "review-thread item count"),
    projectId: row.project_id,
    resolvedAt: row.resolved_at,
    resolvedByMembershipId: row.resolved_by_membership_id,
    reviewId: row.review_id,
    revision: portableNumber(row.revision, "review-thread revision"),
    rootItemId: row.root_item_id,
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    threadId: row.thread_id,
    updatedAt: row.updated_at,
  };
}

function mapThreadItem(row: ThreadItemRow): CloudReviewThreadItemRecord {
  return {
    createdAt: row.created_at,
    createdByMembershipId: row.created_by_membership_id,
    itemId: row.item_id,
    itemType: row.item_type,
    parentItemId: row.parent_item_id,
    payload: {
      algorithm: row.payload_algorithm,
      ciphertext: row.payload_ciphertext,
      ciphertextSha256: row.payload_ciphertext_sha256,
      nonce: row.payload_nonce,
    },
    projectId: row.project_id,
    reviewId: row.review_id,
    revision: portableNumber(row.revision, "review-thread item revision"),
    suggestionDecidedAt: row.suggestion_decided_at,
    suggestionDecidedByMembershipId: row.suggestion_decided_by_membership_id,
    suggestionDecision: row.suggestion_decision,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    threadId: row.thread_id,
    updatedAt: row.updated_at,
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
