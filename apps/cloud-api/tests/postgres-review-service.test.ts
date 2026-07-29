import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CloudReviewListResponseSchema,
  CloudReviewResponseSchema,
  CloudReviewSuggestionDecisionResponseSchema,
  CloudReviewThreadItemListResponseSchema,
  CloudReviewThreadItemResponseSchema,
  CloudReviewThreadListResponseSchema,
  CloudReviewThreadResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudReviewCiphertextEnvelope,
  type CloudReviewSubmissionRequest,
} from "@inkshadow/contracts";
import type { Pool, PoolClient } from "pg";

import { createCloudApiServer } from "../src/http/server.js";
import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { PostgresCloudReviewStore } from "../src/postgres/review-store.js";
import { CloudPageCursorCodec } from "../src/security/page-cursor.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import type { CloudIdentityService, CloudPrincipal } from "../src/service/identity-service.js";
import type { CloudProjectSyncService } from "../src/service/project-sync-service.js";
import { CloudReviewService } from "../src/service/review-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const now = new Date("2026-07-28T08:00:00.000Z");

describePostgres("PostgreSQL Studio encrypted review service", () => {
  let pool: Pool;
  let uuid: ReturnType<typeof createMonotonicUuidV7Factory>;
  let service: CloudReviewService;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      applicationName: "inkshadow-encrypted-review-test",
      connectionString: databaseUrl,
      maximumConnections: 16,
      requireTls: false,
    });
    await runCloudMigrations(pool);
    uuid = createMonotonicUuidV7Factory(
      () => now.getTime(),
      (target) => randomBytes(target.length).copy(target),
    );
    service = new CloudReviewService({
      clock: () => now,
      pageCursorCodec: new CloudPageCursorCodec(Buffer.alloc(32, 0xe1)),
      store: new PostgresCloudReviewStore(pool),
      uuid,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("completes immutable submission, encrypted threads, decisions, CAS and metadata-only suggestion acceptance", async () => {
    const fixture = await seedFixture(pool, uuid, "review-happy");
    const submission = reviewSubmission(fixture, uuid(), ciphertextEnvelope(0x31));
    const created = await service.submitReview(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      submission,
      mutation(uuid(), "review-submit-happy-idempotency-0001"),
    );
    const replay = await service.submitReview(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      submission,
      mutation(uuid(), "review-submit-happy-idempotency-0001"),
    );
    expect(replay.review).toEqual(created.review);
    expect(replay.requestId).not.toBe(created.requestId);
    expect(
      (
        await service.listReviews(
          fixture.author,
          fixture.teamId,
          fixture.projectId,
          null,
          50,
          read(uuid()),
        )
      ).reviews,
    ).toEqual([
      expect.objectContaining({
        reviewId: submission.reviewId,
        sourceVersionId: submission.sourceVersionId,
        state: "pending",
      }),
    ]);
    const fetched = await service.getReview(
      fixture.reviewer,
      fixture.teamId,
      fixture.projectId,
      submission.reviewId,
      read(uuid()),
    );
    expect(fetched.review.payload).toEqual(submission.payload);

    const threadId = uuid();
    const suggestionId = uuid();
    const suggestion = await service.appendThreadItem(
      fixture.reviewer,
      fixture.teamId,
      fixture.projectId,
      submission.reviewId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedThreadRevision: null,
        itemId: suggestionId,
        itemType: "suggestion",
        parentItemId: null,
        payload: ciphertextEnvelope(0x32),
        threadId,
      },
      mutation(uuid(), "review-suggestion-root-idempotency-0001"),
    );
    expect(suggestion.item.suggestionDecision).toBe("pending");

    const questionThreadId = uuid();
    await service.appendThreadItem(
      fixture.reviewer,
      fixture.teamId,
      fixture.projectId,
      submission.reviewId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedThreadRevision: null,
        itemId: uuid(),
        itemType: "question",
        parentItemId: null,
        payload: ciphertextEnvelope(0x34),
        threadId: questionThreadId,
      },
      mutation(uuid(), "review-question-root-idempotency-0001"),
    );
    const firstThreadPage = await service.listThreads(
      fixture.reviewer,
      fixture.teamId,
      fixture.projectId,
      submission.reviewId,
      null,
      1,
      read(uuid()),
    );
    expect(firstThreadPage.threads).toHaveLength(1);
    expect(firstThreadPage.nextCursor).not.toBeNull();
    const secondThreadPage = await service.listThreads(
      fixture.reviewer,
      fixture.teamId,
      fixture.projectId,
      submission.reviewId,
      firstThreadPage.nextCursor,
      1,
      read(uuid()),
    );
    expect(
      new Set([firstThreadPage.threads[0]?.threadId, secondThreadPage.threads[0]?.threadId]),
    ).toEqual(new Set([threadId, questionThreadId]));
    expect(secondThreadPage.nextCursor).toBeNull();

    const replyId = uuid();
    const reply = await service.appendThreadItem(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      submission.reviewId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedThreadRevision: suggestion.thread.revision,
        itemId: replyId,
        itemType: "reply",
        parentItemId: suggestionId,
        payload: ciphertextEnvelope(0x33),
        threadId,
      },
      mutation(uuid(), "review-reply-idempotency-0001"),
    );
    expect(reply.thread).toMatchObject({ itemCount: 2, revision: 2 });
    const itemPage = await service.listThreadItems(
      fixture.reviewer,
      fixture.teamId,
      fixture.projectId,
      submission.reviewId,
      threadId,
      null,
      50,
      read(uuid()),
    );
    expect(itemPage.items.map((item) => item.itemId)).toEqual([suggestionId, replyId]);

    await expect(
      service.decideSuggestion(
        fixture.reviewer,
        fixture.teamId,
        fixture.projectId,
        submission.reviewId,
        threadId,
        suggestionId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          decision: "accepted",
          expectedRevision: 1,
        },
        mutation(uuid(), "reviewer-overwrite-denial-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    const decidedSuggestion = await service.decideSuggestion(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      submission.reviewId,
      threadId,
      suggestionId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        decision: "accepted",
        expectedRevision: 1,
      },
      mutation(uuid(), "author-suggestion-decision-idempotency-0001"),
    );
    expect(decidedSuggestion).toMatchObject({
      effect: "metadata_only_no_content_mutation",
      item: {
        revision: 2,
        suggestionDecision: "accepted",
      },
    });

    const resolved = await service.resolveThread(
      fixture.reviewer,
      fixture.teamId,
      fixture.projectId,
      submission.reviewId,
      threadId,
      { schemaVersion: CONTRACT_SCHEMA_VERSION, expectedRevision: reply.thread.revision },
      mutation(uuid(), "review-thread-resolution-idempotency-0001"),
    );
    expect(resolved.thread).toMatchObject({ revision: 3, state: "resolved" });
    await expect(
      service.resolveThread(
        fixture.reviewer,
        fixture.teamId,
        fixture.projectId,
        submission.reviewId,
        threadId,
        { schemaVersion: CONTRACT_SCHEMA_VERSION, expectedRevision: 2 },
        mutation(uuid(), "review-thread-stale-resolution-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const approved = await service.decideReview(
      fixture.reviewer,
      fixture.teamId,
      fixture.projectId,
      submission.reviewId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        decision: "approved",
        expectedRevision: 1,
      },
      mutation(uuid(), "review-approval-idempotency-0001"),
    );
    expect(approved.review).toMatchObject({ revision: 2, state: "approved" });
    await expect(
      service.decideReview(
        fixture.reviewer,
        fixture.teamId,
        fixture.projectId,
        submission.reviewId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          decision: "rejected",
          expectedRevision: 1,
        },
        mutation(uuid(), "review-stale-decision-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(
      service.submitReview(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        { ...submission, sourceVersionRevision: 4 },
        mutation(uuid(), "review-submit-happy-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const persisted = await pool.query<{
      audit_count: string;
      project_revision: string;
      review_count: string;
      sync_count: string;
    }>(
      `SELECT
         (
           SELECT count(*)::text
           FROM cloud_review_submissions
           WHERE review_id = $1
         ) AS review_count,
         (
           SELECT count(*)::text
           FROM cloud_team_audit_events
           WHERE resource_id IN ($1, $2, $3)
         ) AS audit_count,
         (
           SELECT revision::text
           FROM cloud_projects
           WHERE tenant_id = $4
             AND project_id = $5
         ) AS project_revision,
         (
           SELECT count(*)::text
           FROM sync_operations
           WHERE tenant_id = $4
             AND project_id = $5
         ) AS sync_count`,
      [submission.reviewId, suggestionId, threadId, fixture.owner.accountId, fixture.projectId],
    );
    expect(persisted.rows).toEqual([
      {
        audit_count: "6",
        project_revision: "1",
        review_count: "1",
        sync_count: "0",
      },
    ]);
    const denialAudit = await pool.query<{
      action: string;
      reason: string;
      result: string;
    }>(
      `SELECT action, result, reason
       FROM cloud_team_audit_events
       WHERE resource_id = $1
         AND result = 'denied'`,
      [suggestionId],
    );
    expect(denialAudit.rows).toEqual([
      {
        action: "review_suggestion.decision_recorded",
        reason: "role_forbidden",
        result: "denied",
      },
    ]);

    await pool.query(
      `UPDATE cloud_idempotency_records
       SET response_snapshot = jsonb_set(
         response_snapshot,
         '{requestId}',
         to_jsonb($2::text),
         false
       )
       WHERE operation_id = 'reviews.submit'
         AND result_resource_id = $1`,
      [submission.reviewId, uuid()],
    );
    await expect(
      service.submitReview(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        submission,
        mutation(uuid(), "review-submit-happy-idempotency-0001"),
      ),
    ).rejects.toThrow("review idempotency record is internally inconsistent");
  });

  it("fails closed for malformed ciphertext, revoked principals, unassigned managers and non-review roles", async () => {
    const fixture = await seedFixture(pool, uuid, "review-denials");
    const submission = reviewSubmission(fixture, uuid(), ciphertextEnvelope(0x41));
    await expect(
      service.submitReview(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        {
          ...submission,
          payload: { ...submission.payload, ciphertextSha256: "0".repeat(64) },
        },
        mutation(uuid(), "review-invalid-ciphertext-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "SYNC_INVALID_CIPHERTEXT" });
    expect(
      (
        await pool.query("SELECT 1 FROM cloud_review_submissions WHERE review_id = $1", [
          submission.reviewId,
        ])
      ).rowCount,
    ).toBe(0);

    await service.submitReview(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      submission,
      mutation(uuid(), "review-denials-submit-idempotency-0001"),
    );
    await expect(
      service.listReviews(fixture.owner, fixture.teamId, fixture.projectId, null, 50, read(uuid())),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      service.listReviews(
        fixture.readOnly,
        fixture.teamId,
        fixture.projectId,
        null,
        50,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    await expect(
      service.listReviews(
        fixture.finance,
        fixture.teamId,
        fixture.projectId,
        null,
        50,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });

    const foreign = await seedFixture(pool, uuid, "review-foreign");
    await expect(
      service.getReview(
        foreign.author,
        fixture.teamId,
        fixture.projectId,
        submission.reviewId,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    await setTeamScope(pool, fixture.owner, fixture.teamId, async (client) => {
      await client.query(
        `UPDATE cloud_team_memberships
         SET state = 'revoked',
             revision = revision + 1,
             revoked_at = $4,
             updated_at = $4
         WHERE tenant_id = $1
           AND team_id = $2
           AND membership_id = $3`,
        [fixture.owner.accountId, fixture.teamId, fixture.reviewerMembershipId, now],
      );
    });
    await expect(
      service.getReview(
        fixture.reviewer,
        fixture.teamId,
        fixture.projectId,
        submission.reviewId,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    await pool.query(
      `UPDATE registered_devices
       SET state = 'revoked',
           revision = revision + 1,
           revoked_at = $2,
           updated_at = $2
       WHERE device_id = $1`,
      [fixture.author.deviceId, now],
    );
    await expect(
      service.getReview(
        fixture.author,
        fixture.teamId,
        fixture.projectId,
        submission.reviewId,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "AUTH_SESSION_EXPIRED" });
  });

  it("enforces forced RLS and immutable ciphertext under a real non-superuser role", async () => {
    const fixture = await seedFixture(pool, uuid, "review-rls");
    const submission = reviewSubmission(fixture, uuid(), ciphertextEnvelope(0x51));
    await service.submitReview(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      submission,
      mutation(uuid(), "review-rls-submit-idempotency-0001"),
    );

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'inkshadow_review_rls_test'
        ) THEN
          CREATE ROLE inkshadow_review_rls_test LOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$
    `);
    await pool.query("ALTER ROLE inkshadow_review_rls_test LOGIN NOSUPERUSER NOBYPASSRLS");
    await pool.query("GRANT USAGE ON SCHEMA public TO inkshadow_review_rls_test");
    await pool.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO inkshadow_review_rls_test",
    );
    await pool.query(
      `GRANT EXECUTE
         ON FUNCTION inkshadow_has_active_review_assignment(UUID, UUID, UUID)
         TO inkshadow_review_rls_test`,
    );

    const limitedUrl = new URL(databaseUrl ?? "");
    limitedUrl.username = "inkshadow_review_rls_test";
    limitedUrl.password = "";
    const limitedPool = createCloudPostgresPool({
      applicationName: "inkshadow-review-rls-role-test",
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
      expect((await client.query("SELECT review_id FROM cloud_review_submissions")).rows).toEqual(
        [],
      );

      await client.query("BEGIN");
      await client.query(
        `SELECT
           set_config('inkshadow.account_id', $1, true),
           set_config('inkshadow.device_id', $2, true),
           set_config('inkshadow.tenant_id', $3, true),
           set_config('inkshadow.team_id', $4, true)`,
        [
          fixture.author.accountId,
          fixture.author.deviceId,
          fixture.owner.accountId,
          fixture.teamId,
        ],
      );
      expect(
        (
          await client.query<{ review_id: string }>(
            "SELECT review_id FROM cloud_review_submissions WHERE review_id = $1",
            [submission.reviewId],
          )
        ).rows,
      ).toEqual([{ review_id: submission.reviewId }]);
      await expect(
        client.query(
          `UPDATE cloud_review_submissions
           SET payload_ciphertext = $2
           WHERE review_id = $1`,
          [submission.reviewId, ciphertextEnvelope(0x52).ciphertext],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query(
        `SELECT
           set_config('inkshadow.account_id', $1, true),
           set_config('inkshadow.device_id', $2, true),
           set_config('inkshadow.tenant_id', $3, true),
           set_config('inkshadow.team_id', $4, true)`,
        [
          fixture.readOnly.accountId,
          fixture.readOnly.deviceId,
          fixture.owner.accountId,
          fixture.teamId,
        ],
      );
      expect((await client.query("SELECT review_id FROM cloud_review_submissions")).rows).toEqual(
        [],
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await limitedPool.end();
    }

    const forbiddenColumns = await pool.query<{ column_name: string; table_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_name = ANY($1::text[])
         AND column_name ~ '(plaintext|prompt|dek|recovery|formal_content)'
       ORDER BY table_name, column_name`,
      [["cloud_review_submissions", "cloud_review_threads", "cloud_review_thread_items"]],
    );
    expect(forbiddenColumns.rows).toEqual([]);
    const auditPayload = await pool.query<{ redacted_diff: string }>(
      `SELECT redacted_diff::text
       FROM cloud_team_audit_events
       WHERE resource_id = $1`,
      [submission.reviewId],
    );
    expect(auditPayload.rows).toHaveLength(1);
    expect(auditPayload.rows[0]?.redacted_diff).not.toContain(submission.payload.ciphertext);
    expect(auditPayload.rows[0]?.redacted_diff).not.toContain(submission.payload.nonce);
    expect(auditPayload.rows[0]?.redacted_diff).not.toContain(submission.payload.ciphertextSha256);
  });

  it("cryptographically erases review ciphertext with the project key during project purge", async () => {
    const fixture = await seedFixture(pool, uuid, "review-purge");
    const submission = reviewSubmission(fixture, uuid(), ciphertextEnvelope(0x5f));
    await service.submitReview(
      fixture.author,
      fixture.teamId,
      fixture.projectId,
      submission,
      mutation(uuid(), "review-purge-submit-idempotency-0001"),
    );
    const associated = await pool.query<{ associated: boolean }>(
      `SELECT inkshadow_review_resource_belongs_to_project($1, $2, $3) AS associated`,
      [fixture.owner.accountId, fixture.projectId, submission.reviewId],
    );
    expect(associated.rows).toEqual([{ associated: true }]);
    const ciphertextCount = await pool.query<{ ciphertext_count: string }>(
      `SELECT inkshadow_count_review_ciphertexts($1, $2)::text AS ciphertext_count`,
      [fixture.owner.accountId, fixture.projectId],
    );
    expect(ciphertextCount.rows).toEqual([{ ciphertext_count: "1" }]);
    await pool.query(
      `DELETE FROM cloud_idempotency_records
       WHERE result_kind = 'review'
         AND result_resource_id IS NOT NULL
         AND inkshadow_review_resource_belongs_to_project($1, $2, result_resource_id)`,
      [fixture.owner.accountId, fixture.projectId],
    );
    await setTenant(pool, fixture.owner.accountId, async (client) => {
      await client.query(
        `DELETE FROM project_key_versions
         WHERE tenant_id = $1
           AND project_id = $2
           AND key_version = 1`,
        [fixture.owner.accountId, fixture.projectId],
      );
    });
    expect(
      (
        await pool.query("SELECT 1 FROM cloud_review_submissions WHERE review_id = $1", [
          submission.reviewId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query("SELECT 1 FROM cloud_review_thread_items WHERE review_id = $1", [
          submission.reviewId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT 1
           FROM cloud_idempotency_records
           WHERE result_kind = 'review'
             AND result_resource_id = $1`,
          [submission.reviewId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("executes all nine published review routes against PostgreSQL", async () => {
    const fixture = await seedFixture(pool, uuid, "review-http");
    const principals = new Map<string, CloudPrincipal>([
      [`author.${"A".repeat(43)}`, fixture.author],
      [`reviewer.${"B".repeat(43)}`, fixture.reviewer],
    ]);
    const identityService = {
      authenticateAccessToken: (token: string) => {
        const principal = principals.get(token);
        return principal === undefined
          ? Promise.reject(new Error("unknown review test token"))
          : Promise.resolve(principal);
      },
    } as unknown as CloudIdentityService;
    const server = createCloudApiServer({
      clock: () => now,
      identityService,
      projectSyncService: {} as CloudProjectSyncService,
      reviewService: service,
      uuid,
    });
    const authorHeaders = authorizationHeader(`author.${"A".repeat(43)}`);
    const reviewerHeaders = authorizationHeader(`reviewer.${"B".repeat(43)}`);
    const submission = reviewSubmission(fixture, uuid(), ciphertextEnvelope(0x61));
    const threadId = uuid();
    const suggestionId = uuid();
    try {
      const submit = await server.inject({
        headers: mutationHeaders(authorHeaders, "review-http-submit-idempotency-0001"),
        method: "POST",
        payload: submission,
        url: `/v1/teams/${fixture.teamId}/projects/${fixture.projectId}/reviews`,
      });
      expect(submit.statusCode).toBe(201);
      CloudReviewResponseSchema.parse(submit.json());

      const list = await server.inject({
        headers: authorHeaders,
        method: "GET",
        url: `/v1/teams/${fixture.teamId}/projects/${fixture.projectId}/reviews?limit=50`,
      });
      expect(list.statusCode).toBe(200);
      expect(CloudReviewListResponseSchema.parse(list.json()).reviews).toHaveLength(1);

      const get = await server.inject({
        headers: reviewerHeaders,
        method: "GET",
        url: `/v1/teams/${fixture.teamId}/projects/${fixture.projectId}/reviews/${submission.reviewId}`,
      });
      expect(get.statusCode).toBe(200);
      CloudReviewResponseSchema.parse(get.json());

      const append = await server.inject({
        headers: mutationHeaders(reviewerHeaders, "review-http-thread-item-idempotency-0001"),
        method: "POST",
        payload: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedThreadRevision: null,
          itemId: suggestionId,
          itemType: "suggestion",
          parentItemId: null,
          payload: ciphertextEnvelope(0x62),
          threadId,
        },
        url: `/v1/teams/${fixture.teamId}/projects/${fixture.projectId}/reviews/${submission.reviewId}/thread-items`,
      });
      expect(append.statusCode).toBe(201);
      const appended = CloudReviewThreadItemResponseSchema.parse(append.json());

      const threads = await server.inject({
        headers: reviewerHeaders,
        method: "GET",
        url: `/v1/teams/${fixture.teamId}/projects/${fixture.projectId}/reviews/${submission.reviewId}/threads`,
      });
      expect(threads.statusCode).toBe(200);
      expect(CloudReviewThreadListResponseSchema.parse(threads.json()).threads).toHaveLength(1);

      const items = await server.inject({
        headers: reviewerHeaders,
        method: "GET",
        url: `/v1/teams/${fixture.teamId}/projects/${fixture.projectId}/reviews/${submission.reviewId}/threads/${threadId}/items`,
      });
      expect(items.statusCode).toBe(200);
      expect(CloudReviewThreadItemListResponseSchema.parse(items.json()).items).toHaveLength(1);

      const suggestionDecision = await server.inject({
        headers: mutationHeaders(authorHeaders, "review-http-suggestion-decision-idempotency-0001"),
        method: "POST",
        payload: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          decision: "rejected",
          expectedRevision: 1,
        },
        url: `/v1/teams/${fixture.teamId}/projects/${fixture.projectId}/reviews/${submission.reviewId}/threads/${threadId}/suggestions/${suggestionId}/decisions`,
      });
      expect(suggestionDecision.statusCode).toBe(200);
      CloudReviewSuggestionDecisionResponseSchema.parse(suggestionDecision.json());

      const resolution = await server.inject({
        headers: mutationHeaders(reviewerHeaders, "review-http-thread-resolution-idempotency-0001"),
        method: "POST",
        payload: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: appended.thread.revision,
        },
        url: `/v1/teams/${fixture.teamId}/projects/${fixture.projectId}/reviews/${submission.reviewId}/threads/${threadId}/resolutions`,
      });
      expect(resolution.statusCode).toBe(200);
      CloudReviewThreadResponseSchema.parse(resolution.json());

      const reviewDecision = await server.inject({
        headers: mutationHeaders(reviewerHeaders, "review-http-review-decision-idempotency-0001"),
        method: "POST",
        payload: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          decision: "rejected",
          expectedRevision: 1,
        },
        url: `/v1/teams/${fixture.teamId}/projects/${fixture.projectId}/reviews/${submission.reviewId}/decisions`,
      });
      expect(reviewDecision.statusCode).toBe(200);
      expect(CloudReviewResponseSchema.parse(reviewDecision.json()).review.state).toBe("rejected");
    } finally {
      await server.close();
    }
  });
});

interface SeededPrincipal extends CloudPrincipal {
  readonly email: string;
}

interface ReviewFixture {
  readonly author: SeededPrincipal;
  readonly authorMembershipId: string;
  readonly finance: SeededPrincipal;
  readonly owner: SeededPrincipal;
  readonly projectId: string;
  readonly readOnly: SeededPrincipal;
  readonly reviewer: SeededPrincipal;
  readonly reviewerMembershipId: string;
  readonly teamId: string;
}

async function seedFixture(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  label: string,
): Promise<ReviewFixture> {
  const owner = await seedPrincipal(pool, uuid, `${label}-owner`, "A");
  const author = await seedPrincipal(pool, uuid, `${label}-author`, "B");
  const reviewer = await seedPrincipal(pool, uuid, `${label}-reviewer`, "C");
  const readOnly = await seedPrincipal(pool, uuid, `${label}-read-only`, "D");
  const finance = await seedPrincipal(pool, uuid, `${label}-finance`, "E");
  const projectId = uuid();
  const teamId = uuid();
  const ownerMembershipId = uuid();
  const authorMembershipId = uuid();
  const reviewerMembershipId = uuid();
  const readOnlyMembershipId = uuid();
  const financeMembershipId = uuid();

  await setTenant(pool, owner.accountId, async (client) => {
    await client.query(
      `INSERT INTO cloud_projects (
         tenant_id,
         project_id,
         owner_account_id,
         state,
         current_key_version,
         revision,
         created_at,
         updated_at
       ) VALUES ($1, $2, $1, 'active', 1, 1, $3, $3)`,
      [owner.accountId, projectId, now],
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
         created_at,
         updated_at,
         publication_request_sha256,
         publication_published_at
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
        sha256(`review-publication-${projectId}`),
      ],
    );
  });

  await setTeamScope(pool, owner, teamId, async (client) => {
    await client.query(
      `INSERT INTO cloud_teams (
         tenant_id,
         team_id,
         display_name,
         state,
         revision,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, 'active', 1, $4, $4)`,
      [owner.accountId, teamId, `${label} Studio`, now],
    );
    await client.query(
      `INSERT INTO cloud_team_memberships (
         tenant_id,
         team_id,
         membership_id,
         account_id,
         role,
         state,
         revision,
         created_at,
         updated_at
       ) VALUES
         ($1, $2, $3, $4, 'owner', 'active', 1, $13, $13),
         ($1, $2, $5, $6, 'author', 'active', 1, $13, $13),
         ($1, $2, $7, $8, 'reviewer', 'active', 1, $13, $13),
         ($1, $2, $9, $10, 'read_only', 'active', 1, $13, $13),
         ($1, $2, $11, $12, 'finance_admin', 'active', 1, $13, $13)`,
      [
        owner.accountId,
        teamId,
        ownerMembershipId,
        owner.accountId,
        authorMembershipId,
        author.accountId,
        reviewerMembershipId,
        reviewer.accountId,
        readOnlyMembershipId,
        readOnly.accountId,
        financeMembershipId,
        finance.accountId,
        now,
      ],
    );
    const assignments = [
      [authorMembershipId, uuid()],
      [reviewerMembershipId, uuid()],
      [readOnlyMembershipId, uuid()],
      [financeMembershipId, uuid()],
    ] as const;
    for (const [membershipId, assignmentId] of assignments) {
      await client.query(
        `INSERT INTO cloud_project_assignments (
           tenant_id,
           team_id,
           project_id,
           membership_id,
           assignment_id,
           state,
           revision,
           granted_by_membership_id,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $7, $7)`,
        [owner.accountId, teamId, projectId, membershipId, assignmentId, ownerMembershipId, now],
      );
    }
  });
  return {
    author,
    authorMembershipId,
    finance,
    owner,
    projectId,
    readOnly,
    reviewer,
    reviewerMembershipId,
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
       account_id,
       email_canonical,
       password_hash,
       state,
       verified_at,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, 'active', $4, $4, $4)`,
    [accountId, email, `scrypt-test-${"x".repeat(32)}`, now],
  );
  await pool.query(
    `INSERT INTO registered_devices (
       device_id,
       account_id,
       display_name,
       algorithm,
       public_key,
       public_key_fingerprint,
       client_version,
       state,
       revision,
       created_at,
       updated_at
     ) VALUES (
       $1, $2, $3, 'DHKEM-P256-HKDF-SHA256', $4, $5, '0.1.0',
       'trusted', 1, $6, $6
     )`,
    [deviceId, accountId, `${label} device`, publicKeyCharacter.repeat(87), sha256(deviceId), now],
  );
  await pool.query(
    `INSERT INTO cloud_sessions (
       session_id,
       account_id,
       device_id,
       client_version,
       minimum_client_version,
       access_token_hash_sha256,
       refresh_token_hash_sha256,
       refresh_generation,
       issued_at,
       expires_at,
       refresh_expires_at,
       last_seen_at
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

function reviewSubmission(
  fixture: ReviewFixture,
  reviewId: string,
  payload: CloudReviewCiphertextEnvelope,
): CloudReviewSubmissionRequest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    payload,
    projectId: fixture.projectId,
    projectKeyVersion: 1,
    reviewId,
    sourceCiphertextSha256: sha256(`source-${reviewId}`),
    sourceVersionId: reviewId.replace(/.$/u, (character) =>
      character === "f" ? "e" : (Number.parseInt(character, 16) + 1).toString(16),
    ),
    sourceVersionRevision: 7,
    teamId: fixture.teamId,
  };
}

function ciphertextEnvelope(fill: number): CloudReviewCiphertextEnvelope {
  const ciphertext = Buffer.alloc(48, fill);
  try {
    return {
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

async function setTeamScope(
  pool: Pool,
  principal: Pick<SeededPrincipal, "accountId" | "deviceId">,
  teamId: string,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT
         set_config('inkshadow.account_id', $1, true),
         set_config('inkshadow.tenant_id', $1, true),
         set_config('inkshadow.team_id', $2, true),
         set_config('inkshadow.device_id', $3, true)`,
      [principal.accountId, teamId, principal.deviceId],
    );
    await operation(client);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

function authorizationHeader(token: string): Readonly<Record<string, string>> {
  return { authorization: `Bearer ${token}` };
}

function mutationHeaders(
  authorization: Readonly<Record<string, string>>,
  idempotencyKey: string,
): Readonly<Record<string, string>> {
  return {
    ...authorization,
    "idempotency-key": idempotencyKey,
  };
}
