import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  ClaimedTeamInvitationOutboxRecord,
  TeamInvitationOutboxRecord,
  TeamInvitationOutboxState,
} from "../domain/team-invitation-outbox-record.js";
import type {
  CancelTeamInvitationOutboxOptions,
  ClaimTeamInvitationOutboxOptions,
  CompleteTeamInvitationOutboxOptions,
  ExecuteTeamInvitationOutboxOptions,
  RetryTeamInvitationOutboxOptions,
  TeamInvitationOutboxStore,
  TeamInvitationOutboxExecutionDecision,
  TeamInvitationOutboxExecutionResult,
} from "../repository/team-invitation-outbox-store.js";

interface ClaimedOutboxRow extends QueryResultRow {
  readonly attempt_count: number;
  readonly available_at: Date;
  readonly created_at: Date;
  readonly delivered_at: Date | null;
  readonly delivery_id: string;
  readonly encryption_key_id: string;
  readonly invitation_expires_at: Date;
  readonly invitation_id: string;
  readonly invitation_role: ClaimedTeamInvitationOutboxRecord["invitationRole"];
  readonly invitation_state: ClaimedTeamInvitationOutboxRecord["invitationState"];
  readonly invitee_email: string;
  readonly last_error_code: string | null;
  readonly lease_expires_at: Date | null;
  readonly lease_owner: string | null;
  readonly revision: number | string;
  readonly state: TeamInvitationOutboxState;
  readonly team_display_name: string;
  readonly team_id: string;
  readonly team_state: ClaimedTeamInvitationOutboxRecord["teamState"];
  readonly tenant_id: string;
  readonly token_auth_tag: Buffer;
  readonly token_ciphertext: Buffer;
  readonly token_nonce: Buffer;
  readonly updated_at: Date;
}

type OutboxQueryable = Pick<Pool | PoolClient, "query">;

export class PostgresTeamInvitationOutboxStore implements TeamInvitationOutboxStore {
  public constructor(private readonly pool: Pool) {}

  public enqueue(record: TeamInvitationOutboxRecord): Promise<void> {
    return insertTeamInvitationOutbox(this.pool, record);
  }

  public async claim(
    options: ClaimTeamInvitationOutboxOptions,
  ): Promise<readonly ClaimedTeamInvitationOutboxRecord[]> {
    requireClaimOptions(options);
    const result = await this.pool.query<ClaimedOutboxRow>(
      `SELECT *
       FROM inkshadow_claim_team_invitation_outbox($1, $2, $3, $4)`,
      [options.workerId, options.now, options.leaseExpiresAt, options.limit],
    );
    return result.rows.map(mapClaimedOutbox);
  }

  public async markDelivered(options: CompleteTeamInvitationOutboxOptions): Promise<boolean> {
    requireCompletionOptions(options);
    const result = await this.pool.query<{ changed: boolean }>(
      `SELECT inkshadow_mark_team_invitation_outbox_delivered(
         $1, $2, $3, $4
       ) AS changed`,
      [options.deliveryId, options.workerId, options.expectedRevision, options.now],
    );
    return result.rows[0]?.changed === true;
  }

  public async executeWithFence(
    options: ExecuteTeamInvitationOutboxOptions,
  ): Promise<TeamInvitationOutboxExecutionResult> {
    requireCompletionOptions(options);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ClaimedOutboxRow>(
        `SELECT *
         FROM inkshadow_lock_team_invitation_outbox_delivery($1, $2, $3, $4)`,
        [options.deliveryId, options.workerId, options.expectedRevision, options.now],
      );
      const row = result.rows[0];
      if (row === undefined) {
        await client.query("COMMIT");
        return { kind: "claim_lost" };
      }
      const record = mapClaimedOutbox(row);
      const decision = await options.operation(record);
      const changed = await applyDecision(client, options, decision);
      if (!changed) {
        throw new Error("The fenced team-invitation outbox transition was rejected.");
      }
      await client.query("COMMIT");
      return { decision, kind: "applied" };
    } catch (error: unknown) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async retry(options: RetryTeamInvitationOutboxOptions): Promise<boolean> {
    requireCompletionOptions(options);
    requireErrorCode(options.errorCode);
    requireDate(options.availableAt, "outbox retry availability");
    if (!options.deadLetter && options.availableAt.getTime() <= options.now.getTime()) {
      throw new Error("The team-invitation retry must be scheduled in the future.");
    }
    const result = await this.pool.query<{ changed: boolean }>(
      `SELECT inkshadow_retry_team_invitation_outbox(
         $1, $2, $3, $4, $5, $6, $7
       ) AS changed`,
      [
        options.deliveryId,
        options.workerId,
        options.expectedRevision,
        options.now,
        options.availableAt,
        options.errorCode,
        options.deadLetter,
      ],
    );
    return result.rows[0]?.changed === true;
  }

  public async cancel(options: CancelTeamInvitationOutboxOptions): Promise<boolean> {
    requireCompletionOptions(options);
    requireErrorCode(options.errorCode);
    const result = await this.pool.query<{ changed: boolean }>(
      `SELECT inkshadow_cancel_team_invitation_outbox(
         $1, $2, $3, $4, $5
       ) AS changed`,
      [
        options.deliveryId,
        options.workerId,
        options.expectedRevision,
        options.now,
        options.errorCode,
      ],
    );
    return result.rows[0]?.changed === true;
  }
}

async function applyDecision(
  client: PoolClient,
  options: CompleteTeamInvitationOutboxOptions,
  decision: TeamInvitationOutboxExecutionDecision,
): Promise<boolean> {
  switch (decision.kind) {
    case "delivered": {
      const result = await client.query<{ changed: boolean }>(
        `SELECT inkshadow_mark_team_invitation_outbox_delivered(
           $1, $2, $3, $4
         ) AS changed`,
        [options.deliveryId, options.workerId, options.expectedRevision, options.now],
      );
      return result.rows[0]?.changed === true;
    }
    case "retry": {
      requireErrorCode(decision.errorCode);
      requireDate(decision.availableAt, "outbox retry availability");
      if (!decision.deadLetter && decision.availableAt.getTime() <= options.now.getTime()) {
        throw new Error("The team-invitation retry must be scheduled in the future.");
      }
      const result = await client.query<{ changed: boolean }>(
        `SELECT inkshadow_retry_team_invitation_outbox(
           $1, $2, $3, $4, $5, $6, $7
         ) AS changed`,
        [
          options.deliveryId,
          options.workerId,
          options.expectedRevision,
          options.now,
          decision.availableAt,
          decision.errorCode,
          decision.deadLetter,
        ],
      );
      return result.rows[0]?.changed === true;
    }
    case "cancel": {
      requireErrorCode(decision.errorCode);
      const result = await client.query<{ changed: boolean }>(
        `SELECT inkshadow_cancel_team_invitation_outbox(
           $1, $2, $3, $4, $5
         ) AS changed`,
        [
          options.deliveryId,
          options.workerId,
          options.expectedRevision,
          options.now,
          decision.errorCode,
        ],
      );
      return result.rows[0]?.changed === true;
    }
  }
}

export async function insertTeamInvitationOutbox(
  queryable: OutboxQueryable,
  record: TeamInvitationOutboxRecord,
): Promise<void> {
  requirePendingRecord(record);
  await queryable.query(
    `INSERT INTO cloud_team_invitation_outbox (
       delivery_id,
       tenant_id,
       team_id,
       invitation_id,
       token_ciphertext,
       token_nonce,
       token_auth_tag,
       encryption_key_id,
       state,
       attempt_count,
       available_at,
       lease_owner,
       lease_expires_at,
       last_error_code,
       revision,
       created_at,
       updated_at,
       delivered_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 'pending', 0, $9,
       NULL, NULL, NULL, 1, $10, $10, NULL
     )`,
    [
      record.deliveryId,
      record.tenantId,
      record.teamId,
      record.invitationId,
      record.tokenCiphertext,
      record.tokenNonce,
      record.tokenAuthTag,
      record.encryptionKeyId,
      record.availableAt,
      record.createdAt,
    ],
  );
}

function mapClaimedOutbox(row: ClaimedOutboxRow): ClaimedTeamInvitationOutboxRecord {
  const record: ClaimedTeamInvitationOutboxRecord = {
    attemptCount: requireNonnegativeSafeInteger(row.attempt_count, "outbox attempt count"),
    availableAt: requireDate(row.available_at, "outbox availability"),
    createdAt: requireDate(row.created_at, "outbox creation"),
    deliveredAt:
      row.delivered_at === null ? null : requireDate(row.delivered_at, "outbox delivery"),
    deliveryId: row.delivery_id,
    encryptionKeyId: row.encryption_key_id,
    invitationExpiresAt: requireDate(row.invitation_expires_at, "invitation expiration"),
    invitationId: row.invitation_id,
    invitationRole: row.invitation_role,
    invitationState: row.invitation_state,
    inviteeEmail: row.invitee_email,
    lastErrorCode: row.last_error_code,
    leaseExpiresAt:
      row.lease_expires_at === null
        ? null
        : requireDate(row.lease_expires_at, "outbox lease expiration"),
    leaseOwner: row.lease_owner,
    revision: requirePositiveSafeInteger(row.revision, "outbox revision"),
    state: row.state,
    teamDisplayName: row.team_display_name,
    teamId: row.team_id,
    teamState: row.team_state,
    tenantId: row.tenant_id,
    tokenAuthTag: requireBuffer(row.token_auth_tag, 16, "outbox authentication tag"),
    tokenCiphertext: requireBuffer(row.token_ciphertext, null, "outbox token ciphertext"),
    tokenNonce: requireBuffer(row.token_nonce, 12, "outbox token nonce"),
    updatedAt: requireDate(row.updated_at, "outbox update"),
  };
  if (record.state !== "leased" || record.leaseOwner === null || record.leaseExpiresAt === null) {
    throw new Error("The claimed team-invitation outbox row is internally inconsistent.");
  }
  return record;
}

function requirePendingRecord(record: TeamInvitationOutboxRecord): void {
  if (
    record.state !== "pending" ||
    record.attemptCount !== 0 ||
    record.revision !== 1 ||
    record.leaseOwner !== null ||
    record.leaseExpiresAt !== null ||
    record.lastErrorCode !== null ||
    record.deliveredAt !== null
  ) {
    throw new Error("Only a fresh pending team-invitation outbox row can be enqueued.");
  }
  requireDate(record.availableAt, "outbox availability");
  requireDate(record.createdAt, "outbox creation");
  requireDate(record.updatedAt, "outbox update");
  if (record.updatedAt.getTime() !== record.createdAt.getTime()) {
    throw new Error("A new team-invitation outbox row must have matching timestamps.");
  }
  requireBuffer(record.tokenNonce, 12, "outbox token nonce");
  requireBuffer(record.tokenAuthTag, 16, "outbox authentication tag");
  requireBuffer(record.tokenCiphertext, null, "outbox token ciphertext");
  if (record.tokenCiphertext.byteLength < 32 || record.tokenCiphertext.byteLength > 1_024) {
    throw new Error("The outbox token ciphertext has an invalid length.");
  }
}

function requireClaimOptions(options: ClaimTeamInvitationOutboxOptions): void {
  requireDate(options.now, "outbox claim");
  requireDate(options.leaseExpiresAt, "outbox lease expiration");
  if (options.leaseExpiresAt.getTime() <= options.now.getTime()) {
    throw new Error("The team-invitation outbox lease must expire in the future.");
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 256) {
    throw new Error("The team-invitation outbox claim limit is invalid.");
  }
}

function requireCompletionOptions(options: CompleteTeamInvitationOutboxOptions): void {
  requireDate(options.now, "outbox completion");
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1) {
    throw new Error("The team-invitation outbox expected revision is invalid.");
  }
}

function requireDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`The ${label} timestamp is invalid.`);
  }
  return value;
}

function requireErrorCode(errorCode: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,99}$/u.test(errorCode)) {
    throw new Error("The team-invitation outbox error code is invalid.");
  }
}

function requireBuffer(value: Buffer, bytes: number | null, label: string): Buffer {
  if (!Buffer.isBuffer(value) || (bytes !== null && value.byteLength !== bytes)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requireNonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number | string, label: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`The ${label} is invalid.`);
  }
  return parsed;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the operation error.
  }
}
