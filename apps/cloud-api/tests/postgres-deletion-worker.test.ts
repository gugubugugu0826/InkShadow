import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Pool, PoolClient } from "pg";

import { CloudDeletionRequestSchema } from "@inkshadow/contracts";

import {
  DELETED_ACCOUNT_PASSWORD_SENTINEL,
  toCloudDeletionRequest,
  type CloudDeletionJobProjectRecord,
  type CloudDeletionJobRecord,
} from "../src/domain/deletion-records.js";
import { PostgresCloudDeletionStore } from "../src/postgres/deletion-store.js";
import {
  PostgresCloudDeletionWorker,
  type CloudDeletionExternalPurgePort,
} from "../src/postgres/deletion-worker.js";
import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const uuid = createMonotonicUuidV7Factory();
const now = new Date("2026-08-10T12:00:00.000Z");

describePostgres("PostgreSQL permanent deletion worker", () => {
  let pool: Pool;
  let store: PostgresCloudDeletionStore;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      connectionString: databaseUrl,
      applicationName: "inkshadow-cloud-deletion-test",
      maximumConnections: 8,
      requireTls: false,
    });
    await runCloudMigrations(pool);
    store = new PostgresCloudDeletionStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("claims once concurrently, resumes every project phase, retains audit, and blocks resurrection", async () => {
    const fixture = await insertProjectFixture(pool, "project-worker");
    const deletionRequestId = uuid();
    await createProjectJob(store, fixture, deletionRequestId, {
      backupRetentionSeconds: 0,
      scheduledFor: now,
    });
    const originalJob = await readJob(store, fixture.accountId, deletionRequestId);
    await expect(
      store.transaction(async (transaction) => {
        await transaction.setTenant(fixture.accountId);
        return transaction.findDeletionJobByConfirmation(
          fixture.accountId,
          "project",
          fixture.projectId,
          originalJob.confirmationId,
        );
      }),
    ).resolves.toMatchObject({
      deletionRequestId,
      targetId: fixture.projectId,
      targetKind: "project",
    });
    await expect(
      store.transaction(async (transaction) => {
        await transaction.setTenant(fixture.accountId);
        return transaction.findDeletionJobByConfirmation(
          fixture.accountId,
          "project",
          uuid(),
          originalJob.confirmationId,
        );
      }),
    ).resolves.toBeNull();
    await expect(
      store.transaction(async (transaction) => {
        await transaction.setTenant(fixture.accountId);
        await transaction.insertDeletionJob({
          ...originalJob,
          confirmationId: uuid(),
          deletionRequestId: uuid(),
        });
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "cloud_deletion_jobs_one_active_target_idx",
    });
    await insertDeletionIdempotency(pool, fixture.accountId, deletionRequestId);
    await expect(
      store.transaction(async (transaction) => {
        await transaction.setTenant(fixture.accountId);
        return transaction.findIdempotency(hash(`scope-deletion-${deletionRequestId}`));
      }),
    ).resolves.toMatchObject({
      actorAccountId: fixture.accountId,
      responseSnapshot: {
        response: { deletionRequestId },
        snapshotKind: "deletion_job_v1",
        tenantId: fixture.accountId,
      },
      resultKind: "deletion_job",
      resultResourceId: deletionRequestId,
    });

    let releaseExternalCheck: (() => void) | undefined;
    let externalCheckEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      externalCheckEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseExternalCheck = resolve;
    });
    const gatedPort: CloudDeletionExternalPurgePort = {
      async findCommitBlocker() {
        externalCheckEntered?.();
        await release;
        return null;
      },
    };
    const firstWorker = deletionWorker(pool, "project-worker-a", () => now, gatedPort);
    const secondWorker = deletionWorker(pool, "project-worker-b", () => now);
    const firstRun = firstWorker.runOnce();
    await entered;
    const secondRun = await secondWorker.runOnce();
    releaseExternalCheck?.();
    const firstResult = await firstRun;

    expect(firstResult.claimed + secondRun.claimed).toBe(1);
    let job = await readJob(store, fixture.accountId, deletionRequestId);
    expect(job).toMatchObject({
      commitStartedAt: now,
      phase: "derived",
      revision: 2,
      state: "purging",
    });
    await expect(
      store.transaction(async (transaction) => {
        await transaction.setTenant(fixture.accountId);
        return transaction.cancelDeletionJob(
          fixture.accountId,
          deletionRequestId,
          job.revision,
          now,
        );
      }),
    ).resolves.toEqual({ kind: "not_cancellable" });

    const phases: string[] = [];
    const restartableWorker = deletionWorker(pool, "project-worker-resume", () => now);
    for (let index = 0; index < 30; index += 1) {
      phases.push(job.phase);
      if (job.state === "purged") {
        break;
      }
      await restartableWorker.runOnce();
      job = await readJob(store, fixture.accountId, deletionRequestId);
    }
    expect(job).toMatchObject({
      backupRetainedUntil: null,
      completedAt: now,
      phase: "complete",
      state: "purged",
    });
    expect(new Set(phases)).toEqual(
      new Set(["derived", "ciphertext", "keys", "access", "marker", "verify", "complete"]),
    );

    const residual = await pool.query<{
      access_count: string;
      batch_count: string;
      chunk_count: string;
      key_count: string;
      key_idempotency_count: string;
      operation_count: string;
      sync_idempotency_count: string;
      tombstone_ack_count: string;
      tombstone_count: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM cloud_project_access
          WHERE tenant_id = $1 AND project_id = $2)::text AS access_count,
         (SELECT COUNT(*) FROM cloud_sync_batches
          WHERE tenant_id = $1 AND project_id = $2)::text AS batch_count,
         (SELECT COUNT(*) FROM sync_ciphertext_chunks
          WHERE tenant_id = $1 AND project_id = $2)::text AS chunk_count,
         (SELECT COUNT(*) FROM project_key_versions
          WHERE tenant_id = $1 AND project_id = $2)::text AS key_count,
         (SELECT COUNT(*) FROM cloud_idempotency_records
          WHERE result_kind = 'project_key' AND result_resource_id = $2)::text
            AS key_idempotency_count,
         (SELECT COUNT(*) FROM cloud_idempotency_records
          WHERE result_kind = 'sync_batch' AND result_resource_id = $3)::text
            AS sync_idempotency_count,
         (SELECT COUNT(*) FROM sync_tombstones
          WHERE tenant_id = $1 AND project_id = $2)::text AS tombstone_count,
         (SELECT COUNT(*) FROM sync_tombstone_acknowledgements
          WHERE tenant_id = $1 AND project_id = $2)::text AS tombstone_ack_count,
         (SELECT COUNT(*) FROM sync_operations
          WHERE tenant_id = $1 AND project_id = $2)::text AS operation_count`,
      [fixture.accountId, fixture.projectId, fixture.batchId],
    );
    expect(residual.rows[0]).toEqual({
      access_count: "0",
      batch_count: "0",
      chunk_count: "0",
      key_count: "0",
      key_idempotency_count: "0",
      operation_count: "0",
      sync_idempotency_count: "0",
      tombstone_ack_count: "0",
      tombstone_count: "0",
    });
    expect(
      (
        await pool.query<{
          current_key_version: number | null;
          deletion_request_id: string;
          state: string;
        }>(
          `SELECT project.state, project.current_key_version, marker.deletion_request_id
           FROM cloud_projects AS project
           JOIN cloud_deletion_markers AS marker
             ON marker.tenant_id = project.tenant_id
            AND marker.target_kind = 'project'
            AND marker.target_id = project.project_id
           WHERE project.tenant_id = $1
             AND project.project_id = $2`,
          [fixture.accountId, fixture.projectId],
        )
      ).rows[0],
    ).toEqual({
      current_key_version: null,
      deletion_request_id: deletionRequestId,
      state: "deleted",
    });
    expect(
      (
        await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM cloud_idempotency_records
           WHERE result_kind = 'deletion_job'
             AND result_resource_id = $1`,
          [deletionRequestId],
        )
      ).rows[0]?.count,
    ).toBe("1");
    expect(
      (
        await pool.query<{ action: string }>(
          `SELECT action
           FROM cloud_audit_events
           WHERE event_id = $1`,
          [fixture.auditEventId],
        )
      ).rows,
    ).toEqual([{ action: "fixture.created" }]);
    await expect(
      tenantTransaction(pool, fixture.accountId, (client) =>
        client.query(
          `UPDATE cloud_projects
           SET state = 'active',
               updated_at = $3
           WHERE tenant_id = $1
             AND project_id = $2`,
          [fixture.accountId, fixture.projectId, now],
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("rechecks holds and cancels atomically before the commit point", async () => {
    const fixture = await insertProjectFixture(pool, "project-cancel");
    const deletionRequestId = uuid();
    const scheduledFor = new Date("2026-08-11T12:00:00.000Z");
    await createProjectJob(store, fixture, deletionRequestId, {
      blockedReason: "legal_hold_active",
      scheduledFor,
    });
    const holdId = uuid();
    await store.transaction(async (transaction) => {
      await transaction.setTenant(fixture.accountId);
      await transaction.insertRetentionHold({
        holdId,
        placedAt: now,
        reason: "legal_hold_active",
        releasedAt: null,
        targetId: fixture.projectId,
        targetKind: "project",
        tenantId: fixture.accountId,
      });
    });

    const worker = deletionWorker(pool, "hold-worker", () => now);
    await worker.runOnce();
    let job = await readJob(store, fixture.accountId, deletionRequestId);
    expect(job).toMatchObject({
      blockedReason: "legal_hold_active",
      commitStartedAt: null,
      state: "blocked",
    });

    await store.transaction(async (transaction) => {
      await transaction.setTenant(fixture.accountId);
      expect(await transaction.releaseRetentionHold(fixture.accountId, holdId, now)).toBe(true);
    });
    const recheckTime = new Date(now.getTime() + 5 * 60_000);
    const recheckWorker = deletionWorker(pool, "hold-recheck-worker", () => recheckTime);
    await recheckWorker.runOnce();
    job = await readJob(store, fixture.accountId, deletionRequestId);
    expect(job).toMatchObject({
      blockedReason: null,
      commitStartedAt: null,
      state: "grace_period",
    });

    const cancellation = await store.transaction(async (transaction) => {
      await transaction.setTenant(fixture.accountId);
      return transaction.cancelDeletionJob(
        fixture.accountId,
        deletionRequestId,
        job.revision,
        recheckTime,
      );
    });
    expect(cancellation.kind).toBe("cancelled");
    expect(
      (
        await tenantTransaction(pool, fixture.accountId, (client) =>
          client.query(
            `SELECT state, deletion_scheduled_for
             FROM cloud_projects
             WHERE tenant_id = $1
               AND project_id = $2`,
            [fixture.accountId, fixture.projectId],
          ),
        )
      ).rows,
    ).toEqual([{ deletion_scheduled_for: null, state: "active" }]);
  });

  it("keeps a blocked external purge cancellable by extending the frozen deadline", async () => {
    const fixture = await insertProjectFixture(pool, "external-block");
    const deletionRequestId = uuid();
    await createProjectJob(store, fixture, deletionRequestId, {
      scheduledFor: now,
    });
    const pendingExternalPurge: CloudDeletionExternalPurgePort = {
      findCommitBlocker: () => Promise.resolve("external_purge_pending"),
    };
    await deletionWorker(pool, "external-block-worker", () => now, pendingExternalPurge).runOnce();

    const blocked = await readJob(store, fixture.accountId, deletionRequestId);
    const extendedDeadline = new Date(now.getTime() + 5 * 60_000);
    expect(blocked).toMatchObject({
      blockedReason: "external_purge_pending",
      cancellableUntil: extendedDeadline,
      commitStartedAt: null,
      scheduledFor: extendedDeadline,
      state: "blocked",
    });
    const cancellationTime = new Date(now.getTime() + 60_000);
    expect(() =>
      CloudDeletionRequestSchema.parse(toCloudDeletionRequest(blocked, cancellationTime)),
    ).not.toThrow();
    await expect(
      store.transaction(async (transaction) => {
        await transaction.setTenant(fixture.accountId);
        return transaction.cancelDeletionJob(
          fixture.accountId,
          deletionRequestId,
          blocked.revision,
          cancellationTime,
        );
      }),
    ).resolves.toMatchObject({
      job: { state: "cancelled" },
      kind: "cancelled",
    });
  });

  it("purges a frozen account project set, anonymizes identity, and waits for backups", async () => {
    const fixture = await insertProjectFixture(pool, "account-worker");
    await insertAccountIdentityFixture(pool, fixture);
    const teamAccessFixture = await insertAccountTeamAccessFixture(pool, fixture);
    const deletionRequestId = uuid();
    const backupRetentionSeconds = 3_600;
    await createAccountJob(store, fixture, deletionRequestId, backupRetentionSeconds);
    await insertDeletionIdempotency(pool, fixture.accountId, deletionRequestId);

    let workerNow = now;
    const worker = deletionWorker(pool, "account-worker", () => workerNow);
    let job = await readJob(store, fixture.accountId, deletionRequestId);
    for (let index = 0; index < 60 && job.state !== "backup_retention"; index += 1) {
      await worker.runOnce();
      job = await readJob(store, fixture.accountId, deletionRequestId);
    }
    expect(job.state).toBe("backup_retention");
    expect(job.phase).toBe("backup_wait");
    expect(job.backupRetainedUntil?.getTime()).toBe(
      (job.liveDataPurgedAt?.getTime() ?? 0) + backupRetentionSeconds * 1_000,
    );

    const identity = await pool.query<{
      challenge_count: string;
      deletion_idempotency_count: string;
      device_count: string;
      non_deletion_idempotency_count: string;
      session_count: string;
      state: string;
      tombstone_email: boolean;
      tombstone_password: boolean;
      unscrubbed_device_count: string;
    }>(
      `SELECT
         account.state,
         account.email_canonical LIKE 'deleted-%@deleted.invalid' AS tombstone_email,
         account.password_hash = $2 AS tombstone_password,
         (SELECT COUNT(*) FROM identity_challenges
          WHERE account_id = account.account_id)::text AS challenge_count,
         (SELECT COUNT(*) FROM cloud_sessions
          WHERE account_id = account.account_id)::text AS session_count,
         (SELECT COUNT(*) FROM registered_devices
          WHERE account_id = account.account_id)::text AS device_count,
         (SELECT COUNT(*) FROM registered_devices
          WHERE account_id = account.account_id
            AND NOT (
              state = 'revoked'
              AND display_name LIKE 'Deleted device %'
              AND client_version = '0.0.0'
              AND public_key = left(
                replace(device_id::text, '-', '') || repeat('A', 87),
                87
              )
              AND public_key_fingerprint = left(
                replace(device_id::text, '-', '') || repeat('0', 64),
                64
              )
            ))::text AS unscrubbed_device_count,
         (SELECT COUNT(*) FROM cloud_idempotency_records
          WHERE actor_account_id = account.account_id
            AND result_kind <> 'deletion_job')::text AS non_deletion_idempotency_count,
         (SELECT COUNT(*) FROM cloud_idempotency_records
          WHERE actor_account_id = account.account_id
            AND result_kind = 'deletion_job')::text AS deletion_idempotency_count
       FROM cloud_accounts AS account
       WHERE account.account_id = $1`,
      [fixture.accountId, DELETED_ACCOUNT_PASSWORD_SENTINEL],
    );
    expect(identity.rows[0]).toEqual({
      challenge_count: "0",
      deletion_idempotency_count: "1",
      device_count: "1",
      non_deletion_idempotency_count: "0",
      session_count: "0",
      state: "deleted",
      tombstone_email: true,
      tombstone_password: true,
      unscrubbed_device_count: "0",
    });
    const teamAccess = await pool.query<{
      active_team_access: boolean;
      assignment_state: string;
      audit_count: string;
      delivery_key_scrubbed: boolean;
      delivery_lease_scrubbed: boolean;
      delivery_secret_scrubbed: boolean;
      delivery_state: string;
      invitation_email: string;
      invitation_state: string;
      membership_state: string;
      pending_invitation_email: string;
      pending_invitation_state: string;
    }>(
      `SELECT
         membership.state AS membership_state,
         assignment.state AS assignment_state,
         invitation.state AS invitation_state,
         invitation.invitee_email AS invitation_email,
         pending_invitation.state AS pending_invitation_state,
         pending_invitation.invitee_email AS pending_invitation_email,
         delivery.state AS delivery_state,
         (
           delivery.token_ciphertext IS NULL
           AND delivery.token_nonce IS NULL
           AND delivery.token_auth_tag IS NULL
         ) AS delivery_secret_scrubbed,
         delivery.encryption_key_id IS NULL AS delivery_key_scrubbed,
         (
           delivery.lease_owner IS NULL
           AND delivery.lease_expires_at IS NULL
         ) AS delivery_lease_scrubbed,
         inkshadow_account_has_active_team_access($1) AS active_team_access,
         (
           SELECT COUNT(*)::text
           FROM cloud_team_audit_events
           WHERE event_id = ANY($5::uuid[])
             AND request_id = $6
             AND action IN (
               'account_deletion.team_access_revoked',
               'account_deletion.invitation_deidentified'
             )
         ) AS audit_count
       FROM cloud_team_memberships AS membership
       JOIN cloud_project_assignments AS assignment
         ON assignment.tenant_id = membership.tenant_id
        AND assignment.team_id = membership.team_id
        AND assignment.membership_id = membership.membership_id
       JOIN cloud_team_invitations AS invitation
         ON invitation.tenant_id = membership.tenant_id
        AND invitation.team_id = membership.team_id
        AND invitation.accepted_membership_id = membership.membership_id
       JOIN cloud_team_invitations AS pending_invitation
         ON pending_invitation.tenant_id = membership.tenant_id
        AND pending_invitation.team_id = membership.team_id
        AND pending_invitation.invitation_id = $7
       JOIN cloud_team_invitation_outbox AS delivery
         ON delivery.tenant_id = pending_invitation.tenant_id
        AND delivery.team_id = pending_invitation.team_id
        AND delivery.invitation_id = pending_invitation.invitation_id
        AND delivery.delivery_id = $8
       WHERE membership.membership_id = $2
         AND assignment.assignment_id = $3
         AND invitation.invitation_id = $4`,
      [
        fixture.accountId,
        teamAccessFixture.membershipId,
        teamAccessFixture.assignmentId,
        teamAccessFixture.invitationId,
        [
          teamAccessFixture.membershipId,
          teamAccessFixture.invitationId,
          teamAccessFixture.pendingInvitationId,
        ],
        deletionRequestId,
        teamAccessFixture.pendingInvitationId,
        teamAccessFixture.deliveryId,
      ],
    );
    expect(teamAccess.rows[0]).toEqual({
      active_team_access: false,
      assignment_state: "revoked",
      audit_count: "3",
      delivery_key_scrubbed: true,
      delivery_lease_scrubbed: true,
      delivery_secret_scrubbed: true,
      delivery_state: "cancelled",
      invitation_email: `deleted-${deletionRequestId}@deleted.invalid`,
      invitation_state: "accepted",
      membership_state: "revoked",
      pending_invitation_email: `deleted-${deletionRequestId}@deleted.invalid`,
      pending_invitation_state: "revoked",
    });
    expect(
      (
        await pool.query(
          `SELECT action
           FROM cloud_audit_events
           WHERE event_id = $1`,
          [fixture.auditEventId],
        )
      ).rows,
    ).toEqual([{ action: "fixture.created" }]);

    workerNow = new Date((job.backupRetainedUntil?.getTime() ?? now.getTime()) + 1);
    await worker.runOnce();
    job = await readJob(store, fixture.accountId, deletionRequestId);
    expect(job).toMatchObject({
      completedAt: workerNow,
      phase: "complete",
      state: "purged",
    });
  });

  it("restores an account and its frozen child set atomically while leaving old sessions revoked", async () => {
    const fixture = await insertProjectFixture(pool, "account-cancel");
    const projectDeletionRequestId = uuid();
    await createProjectJob(store, fixture, projectDeletionRequestId, {
      scheduledFor: now,
    });
    await store.transaction(async (transaction) => {
      await transaction.setTenant(fixture.accountId);
      const competingJobs = await transaction.listActiveProjectDeletionJobsForOwner(
        fixture.accountId,
        fixture.accountId,
        null,
        10,
        true,
      );
      expect(competingJobs.map((candidate) => candidate.deletionRequestId)).toEqual([
        projectDeletionRequestId,
      ]);
      const projectCancellation = await transaction.cancelDeletionJob(
        fixture.accountId,
        projectDeletionRequestId,
        competingJobs[0]?.revision ?? 0,
        now,
      );
      expect(projectCancellation.kind).toBe("cancelled");
    });
    await insertAccountIdentityFixture(pool, fixture);
    const deletionRequestId = uuid();
    await createAccountJob(store, fixture, deletionRequestId, 0);
    const job = await readJob(store, fixture.accountId, deletionRequestId);

    const cancellation = await store.transaction(async (transaction) => {
      await transaction.setTenant(fixture.accountId);
      return transaction.cancelDeletionJob(fixture.accountId, deletionRequestId, job.revision, now);
    });
    expect(cancellation).toMatchObject({
      job: {
        completedAt: now,
        phase: "freeze",
        state: "cancelled",
      },
      kind: "cancelled",
    });
    const restored = await pool.query<{
      account_state: string;
      project_state: string;
      scheduled_account: Date | null;
      scheduled_project: Date | null;
      unrevoked_session_count: string;
    }>(
      `SELECT
         account.state AS account_state,
         account.deletion_scheduled_for AS scheduled_account,
         project.state AS project_state,
         project.deletion_scheduled_for AS scheduled_project,
         (
           SELECT COUNT(*)
           FROM cloud_sessions
           WHERE account_id = account.account_id
             AND revoked_at IS NULL
         )::text AS unrevoked_session_count
       FROM cloud_accounts AS account
       JOIN cloud_projects AS project
         ON project.tenant_id = account.account_id
        AND project.project_id = $2
       WHERE account.account_id = $1`,
      [fixture.accountId, fixture.projectId],
    );
    expect(restored.rows[0]).toEqual({
      account_state: "active",
      project_state: "active",
      scheduled_account: null,
      scheduled_project: null,
      unrevoked_session_count: "0",
    });
  });
});

interface ProjectFixture {
  readonly accountId: string;
  readonly auditEventId: string;
  readonly batchId: string;
  readonly deviceId: string;
  readonly projectId: string;
}

interface AccountTeamAccessFixture {
  readonly assignmentId: string;
  readonly deliveryId: string;
  readonly invitationId: string;
  readonly membershipId: string;
  readonly pendingInvitationId: string;
}

async function insertAccountTeamAccessFixture(
  pool: Pool,
  fixture: ProjectFixture,
): Promise<AccountTeamAccessFixture> {
  const ownerAccountId = uuid();
  const ownerProjectId = uuid();
  const teamId = uuid();
  const ownerMembershipId = uuid();
  const membershipId = uuid();
  const assignmentId = uuid();
  const invitationId = uuid();
  const pendingInvitationId = uuid();
  const deliveryId = uuid();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO cloud_accounts (
         account_id, email_canonical, password_hash, state,
         verified_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', $4, $4, $4)`,
      [
        ownerAccountId,
        `team-owner-${ownerAccountId}@example.test`,
        `test-scrypt-fixture-${"x".repeat(32)}`,
        now,
      ],
    );
    await client.query(
      `SELECT
         set_config('inkshadow.account_id', $1, true),
         set_config('inkshadow.tenant_id', $1, true),
         set_config('inkshadow.team_id', $2, true)`,
      [ownerAccountId, teamId],
    );
    await client.query(
      `INSERT INTO cloud_projects (
         tenant_id, project_id, owner_account_id, state,
         current_key_version, created_at, updated_at
       ) VALUES ($1, $2, $1, 'active', 1, $3, $3)`,
      [ownerAccountId, ownerProjectId, now],
    );
    await client.query(
      `INSERT INTO cloud_teams (
         tenant_id, team_id, display_name, state, created_at, updated_at
       ) VALUES ($1, $2, 'Deletion worker team', 'active', $3, $3)`,
      [ownerAccountId, teamId, now],
    );
    await client.query(
      `INSERT INTO cloud_team_memberships (
         tenant_id, team_id, membership_id, account_id, role,
         state, created_at, updated_at
       ) VALUES
         ($1, $2, $3, $1, 'owner', 'active', $5, $5),
         ($1, $2, $4, $6, 'author', 'active', $5, $5)`,
      [ownerAccountId, teamId, ownerMembershipId, membershipId, now, fixture.accountId],
    );
    await client.query(
      `INSERT INTO cloud_team_invitations (
         tenant_id, team_id, invitation_id, invitee_email, role, state,
         token_hash_sha256, invited_by_membership_id, accepted_membership_id,
         created_at, updated_at, expires_at, accepted_at
       )
       SELECT
         $1, $2, $3, account.email_canonical, 'author', 'accepted',
         $4, $5, $6, $7, $7, $8, $7
       FROM cloud_accounts AS account
       WHERE account.account_id = $9`,
      [
        ownerAccountId,
        teamId,
        invitationId,
        hash(`invitation-${invitationId}`),
        ownerMembershipId,
        membershipId,
        now,
        new Date(now.getTime() + 60 * 60 * 1_000),
        fixture.accountId,
      ],
    );
    await client.query(
      `INSERT INTO cloud_team_invitations (
         tenant_id, team_id, invitation_id, invitee_email, role, state,
         token_hash_sha256, invited_by_membership_id,
         created_at, updated_at, expires_at
       )
       SELECT
         $1, $2, $3, account.email_canonical, 'author', 'pending',
         $4, $5, $6, $6, $7
       FROM cloud_accounts AS account
       WHERE account.account_id = $8`,
      [
        ownerAccountId,
        teamId,
        pendingInvitationId,
        hash(`invitation-${pendingInvitationId}`),
        ownerMembershipId,
        now,
        new Date(now.getTime() + 60 * 60 * 1_000),
        fixture.accountId,
      ],
    );
    await client.query(
      `INSERT INTO cloud_team_invitation_outbox (
         delivery_id, tenant_id, team_id, invitation_id,
         token_ciphertext, token_nonce, token_auth_tag, encryption_key_id,
         state, available_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         'pending', $9, $9, $9
       )`,
      [
        deliveryId,
        ownerAccountId,
        teamId,
        pendingInvitationId,
        Buffer.from("encrypted-invitation-token"),
        Buffer.alloc(12, 1),
        Buffer.alloc(16, 2),
        "test-invitation-key-v1",
        now,
      ],
    );
    await client.query(
      `INSERT INTO cloud_project_assignments (
         tenant_id, team_id, project_id, membership_id, assignment_id,
         state, granted_by_membership_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7)`,
      [ownerAccountId, teamId, ownerProjectId, membershipId, assignmentId, ownerMembershipId, now],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { assignmentId, deliveryId, invitationId, membershipId, pendingInvitationId };
}

async function insertProjectFixture(pool: Pool, label: string): Promise<ProjectFixture> {
  const accountId = uuid();
  const projectId = uuid();
  const deviceId = uuid();
  const operationId = uuid();
  const deleteOperationId = uuid();
  const chunkId = uuid();
  const versionId = uuid();
  const batchId = uuid();
  const auditEventId = uuid();
  const recoveryId = uuid();
  const envelopeId = uuid();
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
      [accountId, `${label}-${accountId}@example.test`, `scrypt-fixture-${"x".repeat(32)}`, now],
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
         $1, $2, $3, 'DHKEM-P256-HKDF-SHA256',
         $4, $5, '0.1.0', 'trusted', $6, $6
       )`,
      [deviceId, accountId, `${label} device`, "A".repeat(87), hash(`device-${deviceId}`), now],
    );
    await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [accountId]);
    await client.query(
      `INSERT INTO cloud_projects (
         tenant_id,
         project_id,
         owner_account_id,
         state,
         current_key_version,
         created_at,
         updated_at
       ) VALUES ($1, $2, $1, 'active', 1, $3, $3)`,
      [accountId, projectId, now],
    );
    await client.query(
      `INSERT INTO cloud_project_access (
         tenant_id,
         project_id,
         account_id,
         role,
         can_manage_keys,
         can_sync,
         created_at
       ) VALUES ($1, $2, $1, 'owner', true, true, $3)`,
      [accountId, projectId, now],
    );
    await client.query(
      `INSERT INTO project_key_versions (
         tenant_id,
         project_id,
         key_version,
         server_revision,
         algorithm,
         state,
         client_revision,
         recovery_id,
         recovery_algorithm,
         recovery_salt,
         recovery_nonce,
         recovery_ciphertext,
         recovery_verifier,
         recovery_created_at,
         recovery_confirmed_at,
         publication_request_sha256,
         publication_published_at,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, 1, 1, 'AES-256-GCM', 'active', 1, $3,
         'ARGON2ID-AES256GCM', $4, $5, $6, $7, $8, $8, $9, $8, $8, $8
       )`,
      [
        accountId,
        projectId,
        recoveryId,
        "s".repeat(22),
        "n".repeat(16),
        "c".repeat(64),
        "v".repeat(43),
        now,
        hash(`publication-${projectId}`),
      ],
    );
    await client.query(
      `INSERT INTO device_project_key_envelopes (
         tenant_id,
         project_id,
         key_version,
         envelope_id,
         algorithm,
         sender_device_id,
         sender_public_key,
         sender_public_key_fingerprint,
         recipient_device_id,
         recipient_public_key,
         recipient_public_key_fingerprint,
         encapsulated_key,
         ciphertext,
         created_at
       ) VALUES (
         $1, $2, 1, $3, 'HPKE-AUTH-P256-HKDF-SHA256-AES128GCM',
         $4, $5, $6, $4, $5, $6, $7, $8, $9
       )`,
      [
        accountId,
        projectId,
        envelopeId,
        deviceId,
        "A".repeat(87),
        hash(`device-${deviceId}`),
        "B".repeat(87),
        "C".repeat(64),
        now,
      ],
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
         created_at,
         received_at
       ) VALUES (
         $1, $2, $3, $4, 1, 'story_record', $5, 1, 'upsert',
         $6::jsonb, $7::uuid[], $8, $8
       )`,
      [
        accountId,
        projectId,
        operationId,
        deviceId,
        uuid(),
        JSON.stringify({ [deviceId]: 1 }),
        [chunkId],
        now,
      ],
    );
    await client.query(
      `INSERT INTO sync_ciphertext_chunks (
         tenant_id,
         project_id,
         chunk_id,
         operation_id,
         algorithm,
         nonce,
         ciphertext,
         ciphertext_sha256,
         plaintext_bytes,
         object_type,
         object_id,
         version_id,
         chunk_index,
         key_version,
         created_at
       )
       SELECT $1, $2, $3, $4, 'AES-256-GCM', $5, 'YQ', $6, 1,
              operation.object_type, operation.object_id, $7, 0, 1, $8
       FROM sync_operations AS operation
       WHERE operation.operation_id = $4`,
      [
        accountId,
        projectId,
        chunkId,
        operationId,
        "q".repeat(16),
        hash(`chunk-${chunkId}`),
        versionId,
        now,
      ],
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
         created_at,
         received_at
       )
       SELECT $1, $2, $3, $4, 2, operation.object_type, operation.object_id,
              operation.object_generation, 'delete', $5::jsonb,
              ARRAY[]::uuid[], $6, $6
       FROM sync_operations AS operation
       WHERE operation.operation_id = $7`,
      [
        accountId,
        projectId,
        deleteOperationId,
        deviceId,
        JSON.stringify({ [deviceId]: 2 }),
        now,
        operationId,
      ],
    );
    await client.query(
      `INSERT INTO sync_tombstones (
         tenant_id,
         project_id,
         object_type,
         object_id,
         object_generation,
         operation_id,
         deleted_by_device_id,
         version_vector,
         deleted_at,
         retain_until,
         created_at
       )
       SELECT operation.tenant_id, operation.project_id, operation.object_type,
              operation.object_id, operation.object_generation, operation.operation_id,
              operation.device_id, operation.version_vector, $2, $3, $2
       FROM sync_operations AS operation
       WHERE operation.operation_id = $1`,
      [deleteOperationId, now, new Date(now.getTime() + 366 * 24 * 60 * 60 * 1_000)],
    );
    await client.query(
      `INSERT INTO sync_tombstone_acknowledgements (
         tenant_id,
         project_id,
         object_type,
         object_id,
         object_generation,
         device_id,
         acknowledged_at
       )
       SELECT tombstone.tenant_id, tombstone.project_id, tombstone.object_type,
              tombstone.object_id, tombstone.object_generation, $2, $3
       FROM sync_tombstones AS tombstone
       WHERE tombstone.operation_id = $1`,
      [deleteOperationId, deviceId, now],
    );
    await client.query(
      `INSERT INTO cloud_sync_batches (
         tenant_id,
         project_id,
         batch_id,
         account_id,
         device_id,
         accepted_operations,
         remote_sequence,
         server_time
       ) VALUES ($1, $2, $3, $1, $4, $5::jsonb, 1, $6)`,
      [
        accountId,
        projectId,
        batchId,
        deviceId,
        JSON.stringify([{ disposition: "accepted", operationId }]),
        now,
      ],
    );
    await insertRawIdempotency(
      client,
      accountId,
      "projectKeys.publish",
      "project_key",
      projectId,
      `project-key-${projectId}`,
    );
    await insertRawIdempotency(
      client,
      accountId,
      "sync.push",
      "sync_batch",
      batchId,
      `sync-batch-${batchId}`,
    );
    await client.query(
      `INSERT INTO cloud_audit_events (
         event_id,
         request_id,
         actor_account_id,
         actor_device_id,
         tenant_id,
         resource_type,
         resource_id,
         action,
         result,
         redacted_diff,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $3, 'deletion_fixture', $5,
         'fixture.created', 'allowed', '{}'::jsonb, $6
       )`,
      [auditEventId, uuid(), accountId, deviceId, projectId, now],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { accountId, auditEventId, batchId, deviceId, projectId };
}

async function insertAccountIdentityFixture(pool: Pool, fixture: ProjectFixture): Promise<void> {
  const challengeId = uuid();
  const sessionId = uuid();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity_challenges (
         challenge_id,
         kind,
         email_canonical,
         account_id,
         code_hash_sha256,
         expires_at,
         created_at
       )
       SELECT $1, 'password_reset', account.email_canonical, account.account_id,
              $2, $3, $4
       FROM cloud_accounts AS account
       WHERE account.account_id = $5`,
      [
        challengeId,
        hash(`challenge-${challengeId}`),
        new Date(now.getTime() + 60_000),
        now,
        fixture.accountId,
      ],
    );
    await client.query(
      `INSERT INTO cloud_sessions (
         session_id,
         account_id,
         device_id,
         client_version,
         minimum_client_version,
         access_token_hash_sha256,
         refresh_token_hash_sha256,
         issued_at,
         expires_at,
         refresh_expires_at,
         last_seen_at
       ) VALUES (
         $1, $2, $3, '0.1.0', '0.1.0', $4, $5, $6, $7, $8, $6
       )`,
      [
        sessionId,
        fixture.accountId,
        fixture.deviceId,
        hash(`access-${sessionId}`),
        hash(`refresh-${sessionId}`),
        now,
        new Date(now.getTime() + 60_000),
        new Date(now.getTime() + 120_000),
      ],
    );
    await insertRawIdempotency(
      client,
      fixture.accountId,
      "devices.list",
      "device",
      fixture.deviceId,
      `device-${fixture.deviceId}`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createProjectJob(
  store: PostgresCloudDeletionStore,
  fixture: ProjectFixture,
  deletionRequestId: string,
  options: {
    readonly backupRetentionSeconds?: number;
    readonly blockedReason?: "legal_hold_active";
    readonly scheduledFor: Date;
  },
): Promise<void> {
  const requestedAt = now;
  await store.transaction(async (transaction) => {
    await transaction.setTenant(fixture.accountId);
    const project = await transaction.findProject(fixture.accountId, fixture.projectId, true);
    if (project === null) {
      throw new Error("Deletion test project is missing.");
    }
    const impact = await transaction.calculateProjectImpact(fixture.accountId, fixture.projectId);
    await transaction.insertDeletionJob({
      attemptCount: 0,
      backupRetainedUntil: null,
      backupRetentionSeconds: options.backupRetentionSeconds ?? 0,
      blockedReason: options.blockedReason ?? null,
      cancellableUntil: options.scheduledFor,
      commitStartedAt: null,
      completedAt: null,
      confirmationId: uuid(),
      createdAt: requestedAt,
      deletionRequestId,
      impact,
      lastFailureCode: null,
      leaseExpiresAt: null,
      leaseOwner: null,
      liveDataPurgedAt: null,
      nextAttemptAt: now,
      phase: "freeze",
      requestedAt,
      requestedByAccountId: fixture.accountId,
      revision: 1,
      scheduledFor: options.scheduledFor,
      state: options.blockedReason === undefined ? "grace_period" : "blocked",
      targetId: fixture.projectId,
      targetKind: "project",
      tenantId: fixture.accountId,
      updatedAt: requestedAt,
    });
    expect(
      await transaction.freezeProject(
        fixture.accountId,
        fixture.projectId,
        project.revision,
        options.scheduledFor,
        requestedAt,
      ),
    ).toBe(true);
  });
}

async function createAccountJob(
  store: PostgresCloudDeletionStore,
  fixture: ProjectFixture,
  deletionRequestId: string,
  backupRetentionSeconds: number,
): Promise<void> {
  const requestedAt = now;
  await store.transaction(async (transaction) => {
    await transaction.setTenant(fixture.accountId);
    const account = await transaction.findAccountById(fixture.accountId, true);
    const project = await transaction.findProject(fixture.accountId, fixture.projectId, true);
    if (account === null || project === null) {
      throw new Error("Deletion test account fixture is missing.");
    }
    const impact = await transaction.calculateAccountImpact(fixture.accountId, fixture.accountId);
    const job: CloudDeletionJobRecord = {
      attemptCount: 0,
      backupRetainedUntil: null,
      backupRetentionSeconds,
      blockedReason: null,
      cancellableUntil: now,
      commitStartedAt: null,
      completedAt: null,
      confirmationId: uuid(),
      createdAt: requestedAt,
      deletionRequestId,
      impact,
      lastFailureCode: null,
      leaseExpiresAt: null,
      leaseOwner: null,
      liveDataPurgedAt: null,
      nextAttemptAt: now,
      phase: "freeze",
      requestedAt,
      requestedByAccountId: fixture.accountId,
      revision: 1,
      scheduledFor: now,
      state: "grace_period",
      targetId: fixture.accountId,
      targetKind: "account",
      tenantId: fixture.accountId,
      updatedAt: requestedAt,
    };
    await transaction.insertDeletionJob(job);
    const frozenProject: CloudDeletionJobProjectRecord = {
      completedAt: null,
      deletionRequestId,
      ordinal: 0,
      originalDeletionScheduledFor: project.deletionScheduledFor,
      originalState: project.state === "deletion_scheduled" ? "deletion_scheduled" : "active",
      phase: "derived",
      projectId: fixture.projectId,
      projectRevisionAtFreeze: project.revision,
      tenantId: fixture.accountId,
      updatedAt: requestedAt,
    };
    await transaction.insertDeletionJobProject(frozenProject);
    expect(
      await transaction.freezeProject(
        fixture.accountId,
        fixture.projectId,
        project.revision,
        now,
        requestedAt,
      ),
    ).toBe(true);
    expect(
      await transaction.freezeAccount(fixture.accountId, account.revision, now, requestedAt),
    ).toBe(true);
    await transaction.revokeSessionsForAccount(fixture.accountId, requestedAt);
  });
}

async function insertDeletionIdempotency(
  pool: Pool,
  accountId: string,
  deletionRequestId: string,
): Promise<void> {
  await insertRawIdempotency(
    pool,
    accountId,
    "projectDeletions.request",
    "deletion_job",
    deletionRequestId,
    `deletion-${deletionRequestId}`,
    {
      response: { deletionRequestId },
      snapshotKind: "deletion_job_v1",
      tenantId: accountId,
    },
  );
}

async function insertRawIdempotency(
  queryable: Pick<Pool | PoolClient, "query">,
  accountId: string,
  operationId: string,
  resultKind: string,
  resultResourceId: string,
  unique: string,
  responseSnapshot: Readonly<Record<string, unknown>> | null = null,
): Promise<void> {
  await queryable.query(
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
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 200, $10, $11)`,
    [
      hash(`scope-${unique}`),
      accountId,
      operationId,
      hash(`key-${unique}`),
      hash(`request-${unique}`),
      responseSnapshot === null ? null : JSON.stringify(responseSnapshot),
      resultKind,
      resultResourceId,
      hash(`result-${unique}`),
      now,
      new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    ],
  );
}

function deletionWorker(
  pool: Pool,
  workerId: string,
  clock: () => Date,
  externalPurgePort?: CloudDeletionExternalPurgePort,
): PostgresCloudDeletionWorker {
  return new PostgresCloudDeletionWorker(pool, {
    batchSize: 2,
    clock,
    ...(externalPurgePort === undefined ? {} : { externalPurgePort }),
    tenantsPerRun: 128,
    workerId,
  });
}

async function readJob(
  store: PostgresCloudDeletionStore,
  tenantId: string,
  deletionRequestId: string,
): Promise<CloudDeletionJobRecord> {
  const job = await store.transaction(async (transaction) => {
    await transaction.setTenant(tenantId);
    return transaction.findDeletionJob(tenantId, deletionRequestId);
  });
  if (job === null) {
    throw new Error("Deletion test job is missing.");
  }
  return job;
}

async function tenantTransaction<Result>(
  pool: Pool,
  tenantId: string,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
