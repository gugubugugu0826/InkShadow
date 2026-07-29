import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { CloudProjectRecord } from "../domain/project-records.js";
import type { CloudPageAnchor } from "../domain/records.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamMembershipRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type {
  CloudAiProjectBudgetRecord,
  CloudAiTeamBudgetRecord,
  CloudAiUsageEventRecord,
  CloudAiUsageIdempotencyRecord,
  CloudAiUsageMonthRecord,
  CloudAiUsageReservationRecord,
} from "../domain/usage-records.js";
import type { CloudAiUsageStore, CloudAiUsageTransaction } from "../repository/usage-store.js";
import type { CloudPrincipal } from "../service/identity-service.js";

interface TeamBudgetRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly team_id: string;
  readonly currency: string;
  readonly monthly_limit_microunits: number | string;
  readonly warning_threshold_basis_points: number;
  readonly hard_cap: boolean;
  readonly price_version: string;
  readonly input_microunits_per_million_tokens: number | string;
  readonly output_microunits_per_million_tokens: number | string;
  readonly maximum_concurrent_runs: number;
  readonly revision: number | string;
  readonly updated_by_membership_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ProjectBudgetRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly team_id: string;
  readonly project_id: string;
  readonly monthly_limit_microunits: number | string | null;
  readonly maximum_concurrent_runs: number | null;
  readonly revision: number | string;
  readonly updated_by_membership_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface UsageMonthRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly team_id: string;
  readonly project_id?: string;
  readonly period_start: string;
  readonly settled_microunits: number | string;
  readonly reserved_microunits: number | string;
  readonly input_microunits_per_million_tokens: number | string;
  readonly output_microunits_per_million_tokens: number | string;
  readonly settled_input_tokens: number | string;
  readonly settled_output_tokens: number | string;
  readonly reserved_input_tokens: number | string;
  readonly reserved_output_tokens: number | string;
  readonly updated_at: Date;
}

interface ReservationRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly team_id: string;
  readonly project_id: string;
  readonly reservation_id: string;
  readonly membership_id: string;
  readonly model_identifier: string;
  readonly purpose: CloudAiUsageReservationRecord["purpose"];
  readonly price_version: string;
  readonly currency: string;
  readonly state: CloudAiUsageReservationRecord["state"];
  readonly reserved_input_tokens: number | string;
  readonly reserved_output_tokens: number | string;
  readonly reserved_microunits: number | string;
  readonly input_microunits_per_million_tokens: number | string;
  readonly output_microunits_per_million_tokens: number | string;
  readonly settled_input_tokens: number | string;
  readonly settled_output_tokens: number | string;
  readonly settled_microunits: number | string;
  readonly revision: number | string;
  readonly request_hash_sha256: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly expires_at: Date;
  readonly settled_at: Date | null;
  readonly cancelled_at: Date | null;
  readonly expired_at: Date | null;
}

interface IdempotencyRow extends QueryResultRow {
  readonly idempotency_key_hash_sha256: string;
  readonly actor_account_id: string;
  readonly operation_id: CloudAiUsageIdempotencyRecord["operationId"];
  readonly tenant_id: string;
  readonly team_id: string;
  readonly project_id: string | null;
  readonly resource_id: string;
  readonly request_hash_sha256: string;
  readonly result_revision: number | string;
  readonly response_digest_sha256: string;
  readonly response_snapshot: unknown;
  readonly created_at: Date;
  readonly expires_at: Date;
}

interface UsageEventRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly team_id: string;
  readonly project_id: string;
  readonly event_id: string;
  readonly membership_id: string;
  readonly reservation_id: string;
  readonly request_id: string;
  readonly event_type: CloudAiUsageEventRecord["eventType"];
  readonly input_tokens: number | string;
  readonly output_tokens: number | string;
  readonly cost_microunits: number | string;
  readonly currency: string;
  readonly price_version: string;
  readonly model_identifier: string;
  readonly purpose: CloudAiUsageEventRecord["purpose"];
  readonly created_at: Date;
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

export class PostgresCloudAiUsageStore implements CloudAiUsageStore {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    operation: (transaction: CloudAiUsageTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresCloudAiUsageTransaction(client));
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

class PostgresCloudAiUsageTransaction implements CloudAiUsageTransaction {
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

  public async teamHasActiveProjectAssignment(
    tenantId: string,
    teamId: string,
    projectId: string,
  ): Promise<boolean> {
    const result = await this.client.query<{ assigned: boolean }>(
      `SELECT inkshadow_team_has_active_project_assignment($1, $2, $3) AS assigned`,
      [tenantId, teamId, projectId],
    );
    return result.rows[0]?.assigned === true;
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

  public async lockIdempotency(idempotencyKeyHashSha256: string): Promise<void> {
    const lockId = BigInt.asIntN(64, BigInt(`0x${idempotencyKeyHashSha256.slice(0, 16)}`));
    await this.client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockId.toString()]);
  }

  public async findIdempotency(
    idempotencyKeyHashSha256: string,
  ): Promise<CloudAiUsageIdempotencyRecord | null> {
    const result = await this.client.query<IdempotencyRow>(
      `SELECT *
       FROM cloud_ai_usage_idempotency
       WHERE idempotency_key_hash_sha256 = $1`,
      [idempotencyKeyHashSha256],
    );
    return mapNullable(result.rows[0], mapIdempotency);
  }

  public async purgeExpiredIdempotency(
    idempotencyKeyHashSha256: string,
    actorAccountId: string,
    now: Date,
  ): Promise<void> {
    await this.client.query(
      `DELETE FROM cloud_ai_usage_idempotency
       WHERE idempotency_key_hash_sha256 = $1
         AND actor_account_id = $2
         AND expires_at <= $3`,
      [idempotencyKeyHashSha256, actorAccountId, now],
    );
  }

  public async insertIdempotency(record: CloudAiUsageIdempotencyRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_ai_usage_idempotency (
         idempotency_key_hash_sha256,
         actor_account_id,
         operation_id,
         tenant_id,
         team_id,
         project_id,
         resource_id,
         request_hash_sha256,
         result_revision,
         response_digest_sha256,
         response_snapshot,
         created_at,
         expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        record.idempotencyKeyHashSha256,
        record.actorAccountId,
        record.operationId,
        record.tenantId,
        record.teamId,
        record.projectId,
        record.resourceId,
        record.requestHashSha256,
        record.resultRevision,
        record.responseDigestSha256,
        record.responseSnapshot,
        record.createdAt,
        record.expiresAt,
      ],
    );
  }

  public async lockBudgetScope(
    tenantId: string,
    teamId: string,
    projectId: string | null,
  ): Promise<void> {
    await this.client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended(
           'inkshadow:cloud-ai-budget:' || $1::text || ':' || $2::text || ':' ||
             COALESCE($3::text, 'team'),
           0
         )
       )`,
      [tenantId, teamId, projectId],
    );
  }

  public async findTeamBudget(
    tenantId: string,
    teamId: string,
    forUpdate = false,
  ): Promise<CloudAiTeamBudgetRecord | null> {
    const result = await this.client.query<TeamBudgetRow>(
      `SELECT *
       FROM cloud_ai_team_budgets
       WHERE tenant_id = $1
         AND team_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId],
    );
    return mapNullable(result.rows[0], mapTeamBudget);
  }

  public async insertTeamBudget(record: CloudAiTeamBudgetRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_ai_team_budgets (
         tenant_id, team_id, currency, monthly_limit_microunits,
         warning_threshold_basis_points, hard_cap, price_version,
         input_microunits_per_million_tokens,
         output_microunits_per_million_tokens, maximum_concurrent_runs, revision,
         updated_by_membership_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      teamBudgetParameters(record),
    );
  }

  public async updateTeamBudgetCas(
    record: CloudAiTeamBudgetRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_ai_team_budgets
       SET currency = $3,
           monthly_limit_microunits = $4,
           warning_threshold_basis_points = $5,
           hard_cap = $6,
           price_version = $7,
           input_microunits_per_million_tokens = $8,
           output_microunits_per_million_tokens = $9,
           maximum_concurrent_runs = $10,
           revision = $11,
           updated_by_membership_id = $12,
           updated_at = $13
       WHERE tenant_id = $1
         AND team_id = $2
         AND revision = $14`,
      [
        record.tenantId,
        record.teamId,
        record.currency,
        record.monthlyLimitMicrounits,
        record.warningThresholdBasisPoints,
        record.hardCap,
        record.priceVersion,
        record.inputMicrounitsPerMillionTokens,
        record.outputMicrounitsPerMillionTokens,
        record.maximumConcurrentRuns,
        record.revision,
        record.updatedByMembershipId,
        record.updatedAt,
        expectedRevision,
      ],
    );
    return result.rowCount === 1;
  }

  public async findProjectBudget(
    tenantId: string,
    teamId: string,
    projectId: string,
    forUpdate = false,
  ): Promise<CloudAiProjectBudgetRecord | null> {
    const result = await this.client.query<ProjectBudgetRow>(
      `SELECT *
       FROM cloud_ai_project_budgets
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId, projectId],
    );
    return mapNullable(result.rows[0], mapProjectBudget);
  }

  public async insertProjectBudget(record: CloudAiProjectBudgetRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_ai_project_budgets (
         tenant_id, team_id, project_id, monthly_limit_microunits,
         maximum_concurrent_runs, revision, updated_by_membership_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      projectBudgetParameters(record),
    );
  }

  public async updateProjectBudgetCas(
    record: CloudAiProjectBudgetRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_ai_project_budgets
       SET monthly_limit_microunits = $4,
           maximum_concurrent_runs = $5,
           revision = $6,
           updated_by_membership_id = $7,
           updated_at = $8
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND revision = $9`,
      [
        record.tenantId,
        record.teamId,
        record.projectId,
        record.monthlyLimitMicrounits,
        record.maximumConcurrentRuns,
        record.revision,
        record.updatedByMembershipId,
        record.updatedAt,
        expectedRevision,
      ],
    );
    return result.rowCount === 1;
  }

  public async getOrCreateTeamUsageMonth(
    tenantId: string,
    teamId: string,
    periodStart: string,
    now: Date,
    forUpdate = false,
  ): Promise<CloudAiUsageMonthRecord> {
    await this.client.query(
      `INSERT INTO cloud_ai_team_usage_months (
         tenant_id, team_id, period_start, updated_at
       ) VALUES ($1, $2, $3::date, $4)
       ON CONFLICT (tenant_id, team_id, period_start) DO NOTHING`,
      [tenantId, teamId, periodStart, now],
    );
    const result = await this.client.query<UsageMonthRow>(
      `SELECT *
       FROM cloud_ai_team_usage_months
       WHERE tenant_id = $1
         AND team_id = $2
         AND period_start = $3::date${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId, periodStart],
    );
    return mapUsageMonth(requireRow(result.rows[0], "team usage month"), null);
  }

  public async getOrCreateProjectUsageMonth(
    tenantId: string,
    teamId: string,
    projectId: string,
    periodStart: string,
    now: Date,
    forUpdate = false,
  ): Promise<CloudAiUsageMonthRecord> {
    await this.client.query(
      `INSERT INTO cloud_ai_project_usage_months (
         tenant_id, team_id, project_id, period_start, updated_at
       ) VALUES ($1, $2, $3, $4::date, $5)
       ON CONFLICT (tenant_id, team_id, project_id, period_start) DO NOTHING`,
      [tenantId, teamId, projectId, periodStart, now],
    );
    const result = await this.client.query<UsageMonthRow>(
      `SELECT *
       FROM cloud_ai_project_usage_months
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND period_start = $4::date${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId, projectId, periodStart],
    );
    return mapUsageMonth(requireRow(result.rows[0], "project usage month"), projectId);
  }

  public updateTeamUsageMonth(record: CloudAiUsageMonthRecord): Promise<void> {
    return this.updateUsageMonth("team", record);
  }

  public updateProjectUsageMonth(record: CloudAiUsageMonthRecord): Promise<void> {
    return this.updateUsageMonth("project", record);
  }

  private async updateUsageMonth(
    scope: "team" | "project",
    record: CloudAiUsageMonthRecord,
  ): Promise<void> {
    const projectClause =
      scope === "project" ? "AND project_id = $10::uuid" : "AND $10::uuid IS NULL";
    const table =
      scope === "project" ? "cloud_ai_project_usage_months" : "cloud_ai_team_usage_months";
    const result = await this.client.query(
      `UPDATE ${table}
       SET settled_microunits = $4,
           reserved_microunits = $5,
           settled_input_tokens = $6,
           settled_output_tokens = $7,
           reserved_input_tokens = $8,
           reserved_output_tokens = $9,
           updated_at = $11
       WHERE tenant_id = $1
         AND team_id = $2
         AND period_start = $3::date
         ${projectClause}`,
      [
        record.tenantId,
        record.teamId,
        record.periodStart,
        record.settledMicrounits,
        record.reservedMicrounits,
        record.settledInputTokens,
        record.settledOutputTokens,
        record.reservedInputTokens,
        record.reservedOutputTokens,
        record.projectId,
        record.updatedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Cloud AI usage month changed outside its locked transaction.");
    }
  }

  public async insertReservation(record: CloudAiUsageReservationRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_ai_usage_reservations (
         tenant_id, team_id, project_id, reservation_id, membership_id,
         model_identifier, purpose, price_version, currency, state,
         reserved_input_tokens, reserved_output_tokens, reserved_microunits,
         input_microunits_per_million_tokens,
         output_microunits_per_million_tokens,
         settled_input_tokens, settled_output_tokens, settled_microunits,
         revision, request_hash_sha256, created_at, updated_at, expires_at,
         settled_at, cancelled_at, expired_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
       )`,
      reservationParameters(record),
    );
  }

  public async findReservation(
    tenantId: string,
    teamId: string,
    projectId: string,
    reservationId: string,
    forUpdate = false,
  ): Promise<CloudAiUsageReservationRecord | null> {
    const result = await this.client.query<ReservationRow>(
      `SELECT *
       FROM cloud_ai_usage_reservations
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND reservation_id = $4${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, teamId, projectId, reservationId],
    );
    return mapNullable(result.rows[0], mapReservation);
  }

  public async updateReservationCas(
    record: CloudAiUsageReservationRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_ai_usage_reservations
       SET state = $5,
           settled_input_tokens = $6,
           settled_output_tokens = $7,
           settled_microunits = $8,
           revision = $9,
           updated_at = $10,
           settled_at = $11,
           cancelled_at = $12,
           expired_at = $13
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND reservation_id = $4
         AND revision = $14`,
      [
        record.tenantId,
        record.teamId,
        record.projectId,
        record.reservationId,
        record.state,
        record.settledInputTokens,
        record.settledOutputTokens,
        record.settledMicrounits,
        record.revision,
        record.updatedAt,
        record.settledAt,
        record.cancelledAt,
        record.expiredAt,
        expectedRevision,
      ],
    );
    return result.rowCount === 1;
  }

  public async listExpiredReservations(
    tenantId: string,
    teamId: string,
    now: Date,
    limit: number,
  ): Promise<readonly CloudAiUsageReservationRecord[]> {
    const result = await this.client.query<ReservationRow>(
      `SELECT *
       FROM cloud_ai_usage_reservations
       WHERE tenant_id = $1
         AND team_id = $2
         AND state = 'active'
         AND expires_at <= $3
       ORDER BY created_at, project_id, reservation_id
       LIMIT $4
       FOR UPDATE`,
      [tenantId, teamId, now, limit],
    );
    return result.rows.map(mapReservation);
  }

  public async countActiveReservations(
    tenantId: string,
    teamId: string,
    now: Date,
  ): Promise<number> {
    const result = await this.client.query<{ active_count: number | string }>(
      `SELECT COUNT(*) AS active_count
       FROM cloud_ai_usage_reservations
       WHERE tenant_id = $1
         AND team_id = $2
         AND state = 'active'
         AND expires_at > $3`,
      [tenantId, teamId, now],
    );
    return safeInteger(result.rows[0]?.active_count ?? -1, "AI active reservation count");
  }

  public async countActiveProjectReservations(
    tenantId: string,
    teamId: string,
    projectId: string,
    now: Date,
  ): Promise<number> {
    const result = await this.client.query<{ active_count: number | string }>(
      `SELECT COUNT(*) AS active_count
       FROM cloud_ai_usage_reservations
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND state = 'active'
         AND expires_at > $4`,
      [tenantId, teamId, projectId, now],
    );
    return safeInteger(result.rows[0]?.active_count ?? -1, "AI active project reservation count");
  }

  public async insertUsageEvent(record: CloudAiUsageEventRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_ai_usage_events (
         tenant_id, team_id, project_id, event_id, membership_id,
         reservation_id, request_id, event_type, input_tokens, output_tokens,
         cost_microunits, currency, price_version, model_identifier, purpose,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
       )`,
      [
        record.tenantId,
        record.teamId,
        record.projectId,
        record.eventId,
        record.membershipId,
        record.reservationId,
        record.requestId,
        record.eventType,
        record.inputTokens,
        record.outputTokens,
        record.costMicrounits,
        record.currency,
        record.priceVersion,
        record.modelIdentifier,
        record.purpose,
        record.createdAt,
      ],
    );
  }

  public async listUsageEvents(
    tenantId: string,
    teamId: string,
    projectId: string | null,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudAiUsageEventRecord[]> {
    const result = await this.client.query<UsageEventRow>(
      `SELECT *
       FROM cloud_ai_usage_events
       WHERE tenant_id = $1
         AND team_id = $2
         AND ($3::uuid IS NULL OR project_id = $3::uuid)
         AND (
           $5::timestamptz IS NULL
           OR (created_at, event_id) < ($5::timestamptz, $6::uuid)
         )
       ORDER BY created_at DESC, event_id DESC
       LIMIT $4`,
      [tenantId, teamId, projectId, limit, anchor?.createdAt ?? null, anchor?.id ?? null],
    );
    return result.rows.map(mapUsageEvent);
  }
}

function teamBudgetParameters(record: CloudAiTeamBudgetRecord): unknown[] {
  return [
    record.tenantId,
    record.teamId,
    record.currency,
    record.monthlyLimitMicrounits,
    record.warningThresholdBasisPoints,
    record.hardCap,
    record.priceVersion,
    record.inputMicrounitsPerMillionTokens,
    record.outputMicrounitsPerMillionTokens,
    record.maximumConcurrentRuns,
    record.revision,
    record.updatedByMembershipId,
    record.createdAt,
    record.updatedAt,
  ];
}

function projectBudgetParameters(record: CloudAiProjectBudgetRecord): unknown[] {
  return [
    record.tenantId,
    record.teamId,
    record.projectId,
    record.monthlyLimitMicrounits,
    record.maximumConcurrentRuns,
    record.revision,
    record.updatedByMembershipId,
    record.createdAt,
    record.updatedAt,
  ];
}

function reservationParameters(record: CloudAiUsageReservationRecord): unknown[] {
  return [
    record.tenantId,
    record.teamId,
    record.projectId,
    record.reservationId,
    record.membershipId,
    record.modelIdentifier,
    record.purpose,
    record.priceVersion,
    record.currency,
    record.state,
    record.reservedInputTokens,
    record.reservedOutputTokens,
    record.reservedMicrounits,
    record.inputMicrounitsPerMillionTokens,
    record.outputMicrounitsPerMillionTokens,
    record.settledInputTokens,
    record.settledOutputTokens,
    record.settledMicrounits,
    record.revision,
    record.requestHashSha256,
    record.createdAt,
    record.updatedAt,
    record.expiresAt,
    record.settledAt,
    record.cancelledAt,
    record.expiredAt,
  ];
}

function mapTeamBudget(row: TeamBudgetRow): CloudAiTeamBudgetRecord {
  if (row.warning_threshold_basis_points !== 8_000 || !row.hard_cap) {
    throw new Error("PostgreSQL returned an invalid AI team budget policy.");
  }
  return {
    tenantId: row.tenant_id,
    teamId: row.team_id,
    currency: row.currency,
    monthlyLimitMicrounits: safeInteger(row.monthly_limit_microunits, "AI team budget limit"),
    warningThresholdBasisPoints: 8_000,
    hardCap: true,
    priceVersion: row.price_version,
    inputMicrounitsPerMillionTokens: safeInteger(
      row.input_microunits_per_million_tokens,
      "AI input price",
    ),
    outputMicrounitsPerMillionTokens: safeInteger(
      row.output_microunits_per_million_tokens,
      "AI output price",
    ),
    maximumConcurrentRuns: safeInteger(row.maximum_concurrent_runs, "AI maximum concurrent runs"),
    revision: safeInteger(row.revision, "AI team budget revision"),
    updatedByMembershipId: row.updated_by_membership_id,
    createdAt: validDate(row.created_at, "AI team budget created_at"),
    updatedAt: validDate(row.updated_at, "AI team budget updated_at"),
  };
}

function mapProjectBudget(row: ProjectBudgetRow): CloudAiProjectBudgetRecord {
  return {
    tenantId: row.tenant_id,
    teamId: row.team_id,
    projectId: row.project_id,
    monthlyLimitMicrounits:
      row.monthly_limit_microunits === null
        ? null
        : safeInteger(row.monthly_limit_microunits, "AI project budget limit"),
    maximumConcurrentRuns:
      row.maximum_concurrent_runs === null
        ? null
        : safeInteger(row.maximum_concurrent_runs, "AI project maximum concurrent runs"),
    revision: safeInteger(row.revision, "AI project budget revision"),
    updatedByMembershipId: row.updated_by_membership_id,
    createdAt: validDate(row.created_at, "AI project budget created_at"),
    updatedAt: validDate(row.updated_at, "AI project budget updated_at"),
  };
}

function mapUsageMonth(row: UsageMonthRow, projectId: string | null): CloudAiUsageMonthRecord {
  return {
    tenantId: row.tenant_id,
    teamId: row.team_id,
    projectId,
    periodStart: row.period_start,
    settledMicrounits: safeInteger(row.settled_microunits, "AI settled cost"),
    reservedMicrounits: safeInteger(row.reserved_microunits, "AI reserved cost"),
    settledInputTokens: safeInteger(row.settled_input_tokens, "AI settled input tokens"),
    settledOutputTokens: safeInteger(row.settled_output_tokens, "AI settled output tokens"),
    reservedInputTokens: safeInteger(row.reserved_input_tokens, "AI reserved input tokens"),
    reservedOutputTokens: safeInteger(row.reserved_output_tokens, "AI reserved output tokens"),
    updatedAt: validDate(row.updated_at, "AI usage month updated_at"),
  };
}

function mapReservation(row: ReservationRow): CloudAiUsageReservationRecord {
  return {
    tenantId: row.tenant_id,
    teamId: row.team_id,
    projectId: row.project_id,
    reservationId: row.reservation_id,
    membershipId: row.membership_id,
    modelIdentifier: row.model_identifier,
    purpose: row.purpose,
    priceVersion: row.price_version,
    currency: row.currency,
    state: row.state,
    reservedInputTokens: safeInteger(row.reserved_input_tokens, "AI reserved input tokens"),
    reservedOutputTokens: safeInteger(row.reserved_output_tokens, "AI reserved output tokens"),
    reservedMicrounits: safeInteger(row.reserved_microunits, "AI reserved cost"),
    inputMicrounitsPerMillionTokens: safeInteger(
      row.input_microunits_per_million_tokens,
      "AI reservation input price",
    ),
    outputMicrounitsPerMillionTokens: safeInteger(
      row.output_microunits_per_million_tokens,
      "AI reservation output price",
    ),
    settledInputTokens: safeInteger(row.settled_input_tokens, "AI settled input tokens"),
    settledOutputTokens: safeInteger(row.settled_output_tokens, "AI settled output tokens"),
    settledMicrounits: safeInteger(row.settled_microunits, "AI settled cost"),
    revision: safeInteger(row.revision, "AI reservation revision"),
    requestHashSha256: row.request_hash_sha256,
    createdAt: validDate(row.created_at, "AI reservation created_at"),
    updatedAt: validDate(row.updated_at, "AI reservation updated_at"),
    expiresAt: validDate(row.expires_at, "AI reservation expires_at"),
    settledAt: nullableDate(row.settled_at, "AI reservation settled_at"),
    cancelledAt: nullableDate(row.cancelled_at, "AI reservation cancelled_at"),
    expiredAt: nullableDate(row.expired_at, "AI reservation expired_at"),
  };
}

function mapIdempotency(row: IdempotencyRow): CloudAiUsageIdempotencyRecord {
  return {
    idempotencyKeyHashSha256: row.idempotency_key_hash_sha256,
    actorAccountId: row.actor_account_id,
    operationId: row.operation_id,
    tenantId: row.tenant_id,
    teamId: row.team_id,
    projectId: row.project_id,
    resourceId: row.resource_id,
    requestHashSha256: row.request_hash_sha256,
    resultRevision: safeInteger(row.result_revision, "AI idempotency result revision"),
    responseDigestSha256: row.response_digest_sha256,
    responseSnapshot: row.response_snapshot,
    createdAt: validDate(row.created_at, "AI idempotency created_at"),
    expiresAt: validDate(row.expires_at, "AI idempotency expires_at"),
  };
}

function mapUsageEvent(row: UsageEventRow): CloudAiUsageEventRecord {
  return {
    tenantId: row.tenant_id,
    teamId: row.team_id,
    projectId: row.project_id,
    eventId: row.event_id,
    membershipId: row.membership_id,
    reservationId: row.reservation_id,
    requestId: row.request_id,
    eventType: row.event_type,
    inputTokens: safeInteger(row.input_tokens, "AI event input tokens"),
    outputTokens: safeInteger(row.output_tokens, "AI event output tokens"),
    costMicrounits: safeInteger(row.cost_microunits, "AI event cost"),
    currency: row.currency,
    priceVersion: row.price_version,
    modelIdentifier: row.model_identifier,
    purpose: row.purpose,
    createdAt: validDate(row.created_at, "AI event created_at"),
  };
}

function mapMembership(row: MembershipRow): CloudTeamMembershipRecord {
  return {
    accountId: row.account_id,
    createdAt: validDate(row.created_at, "membership created_at"),
    membershipId: row.membership_id,
    revision: safeInteger(row.revision, "membership revision"),
    revokedAt: nullableDate(row.revoked_at, "membership revoked_at"),
    role: row.role,
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: validDate(row.updated_at, "membership updated_at"),
  };
}

function mapTeam(row: TeamRow): CloudTeamRecord {
  return {
    archivedAt: nullableDate(row.archived_at, "team archived_at"),
    createdAt: validDate(row.created_at, "team created_at"),
    displayName: row.display_name,
    revision: safeInteger(row.revision, "team revision"),
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: validDate(row.updated_at, "team updated_at"),
  };
}

function mapProject(row: ProjectRow): CloudProjectRecord {
  return {
    createdAt: validDate(row.created_at, "project created_at"),
    currentKeyVersion: row.current_key_version,
    deletionScheduledFor: nullableDate(row.deletion_scheduled_for, "project deletion time"),
    minimumAvailableRemoteSequence: BigInt(row.minimum_available_remote_sequence),
    ownerAccountId: row.owner_account_id,
    projectId: row.project_id,
    revision: safeInteger(row.revision, "project revision"),
    state: row.state,
    syncCompactionEpoch: BigInt(row.sync_compaction_epoch),
    tenantId: row.tenant_id,
    updatedAt: validDate(row.updated_at, "project updated_at"),
  };
}

function mapAssignment(row: AssignmentRow): CloudProjectAssignmentRecord {
  return {
    assignmentId: row.assignment_id,
    createdAt: validDate(row.created_at, "assignment created_at"),
    grantedByMembershipId: row.granted_by_membership_id,
    membershipId: row.membership_id,
    projectId: row.project_id,
    revision: safeInteger(row.revision, "assignment revision"),
    revokedAt: nullableDate(row.revoked_at, "assignment revoked_at"),
    revokedByMembershipId: row.revoked_by_membership_id,
    state: row.state,
    teamId: row.team_id,
    tenantId: row.tenant_id,
    updatedAt: validDate(row.updated_at, "assignment updated_at"),
  };
}

function safeInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }
  return parsed;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }
  return value;
}

function nullableDate(value: Date | null, label: string): Date | null {
  return value === null ? null : validDate(value, label);
}

function mapNullable<Row, Value>(
  row: Row | undefined,
  mapper: (value: Row) => Value,
): Value | null {
  return row === undefined ? null : mapper(row);
}

function requireRow<Row>(row: Row | undefined, label: string): Row {
  if (row === undefined) {
    throw new Error(`PostgreSQL did not return the ${label}.`);
  }
  return row;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transactional failure.
  }
}
