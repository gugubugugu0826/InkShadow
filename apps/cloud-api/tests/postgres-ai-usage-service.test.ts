import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";
import type { Pool } from "pg";

import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { PostgresCloudAiUsageStore } from "../src/postgres/usage-store.js";
import { CloudPageCursorCodec } from "../src/security/page-cursor.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import type { CloudPrincipal } from "../src/service/identity-service.js";
import { CloudAiUsageService } from "../src/service/usage-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
let now = new Date("2026-01-31T23:59:00.000Z");

describePostgres("PostgreSQL authoritative AI usage budgets", () => {
  let adminPool: Pool;
  let appPool: Pool;
  let service: CloudAiUsageService;
  let uuid: ReturnType<typeof createMonotonicUuidV7Factory>;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    adminPool = createCloudPostgresPool({
      applicationName: "inkshadow-ai-usage-admin-test",
      connectionString: databaseUrl,
      maximumConnections: 8,
      requireTls: false,
    });
    await runCloudMigrations(adminPool);
    await adminPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'inkshadow_ai_usage_rls_test'
        ) THEN
          CREATE ROLE inkshadow_ai_usage_rls_test LOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$
    `);
    await adminPool.query("ALTER ROLE inkshadow_ai_usage_rls_test LOGIN NOSUPERUSER NOBYPASSRLS");
    await adminPool.query("GRANT USAGE ON SCHEMA public TO inkshadow_ai_usage_rls_test");
    await adminPool.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO inkshadow_ai_usage_rls_test",
    );
    await adminPool.query(
      `GRANT EXECUTE
         ON FUNCTION inkshadow_has_active_team_membership(UUID, UUID),
                     inkshadow_team_has_active_project_assignment(UUID, UUID, UUID)
         TO inkshadow_ai_usage_rls_test`,
    );
    const limitedUrl = new URL(databaseUrl);
    limitedUrl.username = "inkshadow_ai_usage_rls_test";
    limitedUrl.password = "";
    appPool = createCloudPostgresPool({
      applicationName: "inkshadow-ai-usage-rls-test",
      connectionString: limitedUrl.toString(),
      maximumConnections: 8,
      requireTls: false,
    });
    uuid = createMonotonicUuidV7Factory(
      () => now.getTime(),
      (target) => randomBytes(target.length).copy(target),
    );
    service = new CloudAiUsageService({
      clock: () => now,
      idempotencyLifetimeMs: 24 * 60 * 60 * 1_000,
      pageCursorCodec: new CloudPageCursorCodec(Buffer.alloc(32, 0xd1)),
      store: new PostgresCloudAiUsageStore(appPool),
      uuid,
    });
  });

  afterAll(async () => {
    await appPool.end();
    await adminPool.end();
  });

  it("serializes concurrent leases, enforces caps and converges settlement/cancellation replay", async () => {
    const owner = await seedPrincipal(adminPool, uuid, "ai-owner");
    const seeded = await seedTeamProjects(adminPool, uuid, owner, 2);
    const budget = await service.updateTeamBudget(
      owner,
      seeded.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        currency: "AUD",
        monthlyLimitMicrounits: 10_000,
        priceVersion: "aud-2026-01",
        inputMicrounitsPerMillionTokens: 1_000_000,
        outputMicrounitsPerMillionTokens: 2_000_000,
        maximumConcurrentRuns: 2,
      },
      mutation(uuid(), "ai-budget-create-key-0001"),
    );
    expect(budget.budget.maximumConcurrentRuns).toBe(2);
    const projectBudget = await service.updateProjectBudget(
      owner,
      seeded.teamId,
      seeded.projectIds[0] ?? "",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        monthlyLimitMicrounits: null,
        maximumConcurrentRuns: 1,
      },
      mutation(uuid(), "ai-project-budget-create-001"),
    );
    expect(projectBudget.budget.maximumConcurrentRuns).toBe(1);

    const firstRequest = reservation(uuid(), 600, 100);
    const secondRequest = reservation(uuid(), 500, 100);
    const concurrent = await Promise.allSettled([
      service.reserveUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        firstRequest,
        mutation(uuid(), "ai-concurrent-reserve-key-01"),
      ),
      service.reserveUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        secondRequest,
        mutation(uuid(), "ai-concurrent-reserve-key-02"),
      ),
    ]);
    const fulfilledIndex = concurrent.findIndex((result) => result.status === "fulfilled");
    const rejectedIndex = concurrent.findIndex((result) => result.status === "rejected");
    expect(fulfilledIndex).toBeGreaterThanOrEqual(0);
    expect(rejectedIndex).toBeGreaterThanOrEqual(0);
    expect(concurrent[rejectedIndex]).toMatchObject({
      reason: { code: "AI_CONCURRENCY_HARD_CAP" },
      status: "rejected",
    });
    const active = fulfilledIndex === 0 ? firstRequest : secondRequest;
    const blocked = rejectedIndex === 0 ? firstRequest : secondRequest;
    const activeKey =
      fulfilledIndex === 0 ? "ai-concurrent-reserve-key-01" : "ai-concurrent-reserve-key-02";
    const blockedKey =
      rejectedIndex === 0 ? "ai-concurrent-reserve-key-01" : "ai-concurrent-reserve-key-02";
    const activeResponse = concurrent[fulfilledIndex];
    if (activeResponse?.status !== "fulfilled") {
      throw new Error("The concurrent reservation result was not fulfilled.");
    }
    expect(activeResponse.value.summary.concurrencyHardCapReached).toBe(true);
    expect(activeResponse.value.summary.activeLeaseCount).toBe(1);
    expect(activeResponse.value.summary.activeProjectLeaseCount).toBe(1);
    expect(activeResponse.value.summary.maximumConcurrentRuns).toBe(2);
    expect(activeResponse.value.summary.projectMaximumConcurrentRuns).toBe(1);
    expect(activeResponse.value.summary.effectiveMaximumConcurrentRuns).toBe(1);
    await expect(
      service.reserveUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        active,
        mutation(uuid(), activeKey),
      ),
    ).resolves.toMatchObject({
      reservation: { reservationId: active.reservationId, state: "active" },
    });
    await expect(
      service.settleUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        active.reservationId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: 1,
          actualInputTokens: active.estimatedInputTokens + 1,
          actualOutputTokens: active.estimatedOutputTokens,
        },
        mutation(uuid(), "ai-over-settlement-key-001"),
      ),
    ).rejects.toMatchObject({ code: "AI_RESERVATION_STATE_CONFLICT" });

    const settlementRequest = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      expectedRevision: 1,
      actualInputTokens: active.estimatedInputTokens,
      actualOutputTokens: active.estimatedOutputTokens,
    } as const;
    const settled = await service.settleUsage(
      owner,
      seeded.teamId,
      seeded.projectIds[0] ?? "",
      active.reservationId,
      settlementRequest,
      mutation(uuid(), "ai-settlement-replay-key-001"),
    );
    expect(settled.reservation.state).toBe("settled");
    const reserveReplayRequestId = uuid();
    await expect(
      service.reserveUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        active,
        mutation(reserveReplayRequestId, activeKey),
      ),
    ).resolves.toMatchObject({
      requestId: reserveReplayRequestId,
      reservation: {
        reservationId: active.reservationId,
        revision: 1,
        state: "active",
      },
    });
    await expect(
      service.settleUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        active.reservationId,
        settlementRequest,
        mutation(uuid(), "ai-settlement-replay-key-001"),
      ),
    ).resolves.toMatchObject({
      reservation: { reservationId: active.reservationId, state: "settled" },
    });

    const retried = await service.reserveUsage(
      owner,
      seeded.teamId,
      seeded.projectIds[0] ?? "",
      blocked,
      mutation(uuid(), blockedKey),
    );
    expect(retried.reservation.state).toBe("active");
    const cancellation = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      expectedRevision: retried.reservation.revision,
    } as const;
    await expect(
      service.cancelUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        blocked.reservationId,
        cancellation,
        mutation(uuid(), "ai-cancellation-replay-key-01"),
      ),
    ).resolves.toMatchObject({ reservation: { state: "cancelled" } });
    await expect(
      service.cancelUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        blocked.reservationId,
        cancellation,
        mutation(uuid(), "ai-cancellation-replay-key-01"),
      ),
    ).resolves.toMatchObject({ reservation: { state: "cancelled" } });

    await expect(
      service.updateTeamBudget(
        owner,
        seeded.teamId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: budget.budget.revision,
          currency: "USD",
          monthlyLimitMicrounits: 10_000,
          priceVersion: "usd-2026-01",
          inputMicrounitsPerMillionTokens: 1_000_000,
          outputMicrounitsPerMillionTokens: 2_000_000,
          maximumConcurrentRuns: 2,
        },
        mutation(uuid(), "ai-currency-freeze-key-001"),
      ),
    ).rejects.toMatchObject({ code: "AI_BUDGET_CURRENCY_LOCKED" });

    const lowered = await service.updateTeamBudget(
      owner,
      seeded.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: budget.budget.revision,
        currency: "AUD",
        monthlyLimitMicrounits: settled.reservation.settledMicrounits,
        priceVersion: "aud-2026-01",
        inputMicrounitsPerMillionTokens: 1_000_000,
        outputMicrounitsPerMillionTokens: 2_000_000,
        maximumConcurrentRuns: 2,
      },
      mutation(uuid(), "ai-budget-warning-key-0001"),
    );
    expect(lowered.budget.revision).toBe(2);
    const budgetReplayRequestId = uuid();
    await expect(
      service.updateTeamBudget(
        owner,
        seeded.teamId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: null,
          currency: "AUD",
          monthlyLimitMicrounits: 10_000,
          priceVersion: "aud-2026-01",
          inputMicrounitsPerMillionTokens: 1_000_000,
          outputMicrounitsPerMillionTokens: 2_000_000,
          maximumConcurrentRuns: 2,
        },
        mutation(budgetReplayRequestId, "ai-budget-create-key-0001"),
      ),
    ).resolves.toMatchObject({
      requestId: budgetReplayRequestId,
      budget: {
        monthlyLimitMicrounits: 10_000,
        revision: 1,
      },
    });
    const summary = await service.getUsageSummary(
      owner,
      seeded.teamId,
      seeded.projectIds[0] ?? "",
      read(uuid()),
    );
    expect(summary.team?.status).toBe("hard_cap");
    await expect(
      service.reserveUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        reservation(uuid(), 1, 0),
        mutation(uuid(), "ai-money-hard-cap-key-001"),
      ),
    ).rejects.toMatchObject({ code: "AI_BUDGET_HARD_CAP" });

    const expanded = await service.updateTeamBudget(
      owner,
      seeded.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: lowered.budget.revision,
        currency: "AUD",
        monthlyLimitMicrounits: 10_000,
        priceVersion: "aud-2026-01",
        inputMicrounitsPerMillionTokens: 1_000_000,
        outputMicrounitsPerMillionTokens: 2_000_000,
        maximumConcurrentRuns: 2,
      },
      mutation(uuid(), "ai-budget-expand-key-00001"),
    );
    expect(expanded.budget.revision).toBe(3);
    const projectHardCap = await service.updateProjectBudget(
      owner,
      seeded.teamId,
      seeded.projectIds[0] ?? "",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: projectBudget.budget.revision,
        monthlyLimitMicrounits: settled.reservation.settledMicrounits,
        maximumConcurrentRuns: 1,
      },
      mutation(uuid(), "ai-project-budget-cap-00001"),
    );
    await expect(
      service.reserveUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        reservation(uuid(), 1, 0),
        mutation(uuid(), "ai-project-money-cap-key-01"),
      ),
    ).rejects.toMatchObject({ code: "AI_BUDGET_HARD_CAP" });
    const projectExpanded = await service.updateProjectBudget(
      owner,
      seeded.teamId,
      seeded.projectIds[0] ?? "",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: projectHardCap.budget.revision,
        monthlyLimitMicrounits: null,
        maximumConcurrentRuns: 1,
      },
      mutation(uuid(), "ai-project-budget-expand-01"),
    );
    expect(projectExpanded.budget.revision).toBe(3);
    const scopeKey = "ai-cross-project-key-0001";
    const scoped = reservation(uuid(), 10, 0);
    await service.reserveUsage(
      owner,
      seeded.teamId,
      seeded.projectIds[0] ?? "",
      scoped,
      mutation(uuid(), scopeKey),
    );
    const crossProject = reservation(uuid(), 10, 0);
    await expect(
      service.reserveUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[1] ?? "",
        crossProject,
        mutation(uuid(), scopeKey),
      ),
    ).resolves.toMatchObject({
      reservation: { reservationId: crossProject.reservationId, state: "active" },
    });
    await expect(
      service.reserveUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        { ...scoped, estimatedInputTokens: 11 },
        mutation(uuid(), scopeKey),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.reserveUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        { ...scoped, reservationId: uuid() },
        mutation(uuid(), scopeKey),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.cancelUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        scoped.reservationId,
        { schemaVersion: CONTRACT_SCHEMA_VERSION, expectedRevision: 1 },
        mutation(uuid(), scopeKey),
      ),
    ).resolves.toMatchObject({ reservation: { state: "cancelled" } });

    const otherTeam = await seedTeamProjects(adminPool, uuid, owner, 1);
    await service.updateTeamBudget(
      owner,
      otherTeam.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        currency: "AUD",
        monthlyLimitMicrounits: 10_000,
        priceVersion: "aud-2026-01",
        inputMicrounitsPerMillionTokens: 1_000_000,
        outputMicrounitsPerMillionTokens: 2_000_000,
        maximumConcurrentRuns: 2,
      },
      mutation(uuid(), "ai-other-team-budget-key-01"),
    );
    const crossTeam = reservation(uuid(), 10, 0);
    await expect(
      service.reserveUsage(
        owner,
        otherTeam.teamId,
        otherTeam.projectIds[0] ?? "",
        crossTeam,
        mutation(uuid(), scopeKey),
      ),
    ).resolves.toMatchObject({
      reservation: { reservationId: crossTeam.reservationId, state: "active" },
    });
  });

  it("serializes concurrent first-create budget writes without leaking a unique violation", async () => {
    const owner = await seedPrincipal(adminPool, uuid, "ai-budget-race-owner");
    const seeded = await seedTeamProjects(adminPool, uuid, owner, 1);
    const create = (monthlyLimitMicrounits: number, key: string) =>
      service.updateTeamBudget(
        owner,
        seeded.teamId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: null,
          currency: "AUD",
          monthlyLimitMicrounits,
          priceVersion: "aud-2026-01",
          inputMicrounitsPerMillionTokens: 1_000_000,
          outputMicrounitsPerMillionTokens: 2_000_000,
          maximumConcurrentRuns: 2,
        },
        mutation(uuid(), key),
      );
    const results = await Promise.allSettled([
      create(10_000, "ai-budget-race-key-000001"),
      create(20_000, "ai-budget-race-key-000002"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "REVISION_CONFLICT" },
    });
  });

  it("fails closed with a stable validation error before portable token counters overflow", async () => {
    now = new Date("2026-01-31T23:59:10.000Z");
    const owner = await seedPrincipal(adminPool, uuid, "ai-token-overflow-owner");
    const seeded = await seedTeamProjects(adminPool, uuid, owner, 1);
    const projectId = seeded.projectIds[0] ?? "";
    await service.updateTeamBudget(
      owner,
      seeded.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        currency: "AUD",
        monthlyLimitMicrounits: 1,
        priceVersion: "aud-zero-input-2026-01",
        inputMicrounitsPerMillionTokens: 0,
        outputMicrounitsPerMillionTokens: 1,
        maximumConcurrentRuns: 2,
      },
      mutation(uuid(), "ai-token-overflow-budget-01"),
    );

    const maximumReservation = reservation(
      uuid(),
      Number.MAX_SAFE_INTEGER,
      0,
      300,
      "aud-zero-input-2026-01",
    );
    await expect(
      service.reserveUsage(
        owner,
        seeded.teamId,
        projectId,
        maximumReservation,
        mutation(uuid(), "ai-token-overflow-first-001"),
      ),
    ).resolves.toMatchObject({
      reservation: {
        reservedInputTokens: Number.MAX_SAFE_INTEGER,
        reservedMicrounits: 0,
        state: "active",
      },
    });

    const overflowReservation = reservation(uuid(), 1, 0, 300, "aud-zero-input-2026-01");
    await expect(
      service.reserveUsage(
        owner,
        seeded.teamId,
        projectId,
        overflowReservation,
        mutation(uuid(), "ai-token-overflow-second-01"),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
    const summary = await service.getUsageSummary(owner, seeded.teamId, projectId, read(uuid()));
    expect(summary.team?.reservedInputTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(summary.project?.reservedInputTokens).toBe(Number.MAX_SAFE_INTEGER);
    const rolledBack = await adminPool.query<{ reservations: string; events: string }>(
      `SELECT
         (SELECT count(*)::text
            FROM cloud_ai_usage_reservations
           WHERE reservation_id = $1) AS reservations,
         (SELECT count(*)::text
            FROM cloud_ai_usage_events
           WHERE reservation_id = $1) AS events`,
      [overflowReservation.reservationId],
    );
    expect(rolledBack.rows).toEqual([{ events: "0", reservations: "0" }]);
  });

  it("binds author/reviewer leases to their creator and limits reviewers to read-only AI review", async () => {
    const owner = await seedPrincipal(adminPool, uuid, "ai-purpose-owner");
    const firstAuthor = await seedPrincipal(adminPool, uuid, "ai-purpose-author-a");
    const secondAuthor = await seedPrincipal(adminPool, uuid, "ai-purpose-author-b");
    const reviewer = await seedPrincipal(adminPool, uuid, "ai-purpose-reviewer");
    const seeded = await seedTeamProjects(adminPool, uuid, owner, 1);
    const projectId = seeded.projectIds[0] ?? "";
    const firstMembershipId = await seedMembership(
      adminPool,
      uuid,
      owner.accountId,
      seeded.teamId,
      firstAuthor.accountId,
      "author",
    );
    const secondMembershipId = await seedMembership(
      adminPool,
      uuid,
      owner.accountId,
      seeded.teamId,
      secondAuthor.accountId,
      "author",
    );
    const reviewerMembershipId = await seedMembership(
      adminPool,
      uuid,
      owner.accountId,
      seeded.teamId,
      reviewer.accountId,
      "reviewer",
    );
    for (const membershipId of [firstMembershipId, secondMembershipId, reviewerMembershipId]) {
      await seedAssignment(
        adminPool,
        uuid,
        owner.accountId,
        seeded.teamId,
        projectId,
        membershipId,
        seeded.membershipId,
      );
    }
    await service.updateTeamBudget(
      owner,
      seeded.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        currency: "AUD",
        monthlyLimitMicrounits: 10_000,
        priceVersion: "aud-2026-01",
        inputMicrounitsPerMillionTokens: 1_000_000,
        outputMicrounitsPerMillionTokens: 2_000_000,
        maximumConcurrentRuns: 4,
      },
      mutation(uuid(), "ai-purpose-budget-key-0001"),
    );

    const authorLease = await service.reserveUsage(
      firstAuthor,
      seeded.teamId,
      projectId,
      reservation(uuid(), 100, 0),
      mutation(uuid(), "ai-author-a-reserve-key-01"),
    );
    expect(authorLease.summary.capabilities).toEqual({
      manageTeamBudget: false,
      manageProjectBudget: false,
      consume: true,
    });
    const visibleEvents = await service.listUsageEvents(
      secondAuthor,
      seeded.teamId,
      projectId,
      null,
      10,
      read(uuid()),
    );
    expect(
      visibleEvents.events.some(
        (event) => event.reservationId === authorLease.reservation.reservationId,
      ),
    ).toBe(true);
    await expect(
      service.settleUsage(
        secondAuthor,
        seeded.teamId,
        projectId,
        authorLease.reservation.reservationId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: 1,
          actualInputTokens: 100,
          actualOutputTokens: 0,
        },
        mutation(uuid(), "ai-author-b-attack-settle-1"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    await expect(
      service.cancelUsage(
        secondAuthor,
        seeded.teamId,
        projectId,
        authorLease.reservation.reservationId,
        { schemaVersion: CONTRACT_SCHEMA_VERSION, expectedRevision: 1 },
        mutation(uuid(), "ai-author-b-attack-cancel-01"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });

    await expect(
      service.reserveUsage(
        reviewer,
        seeded.teamId,
        projectId,
        reservation(uuid(), 50, 0),
        mutation(uuid(), "ai-reviewer-generation-deny"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    const reviewRequest = {
      ...reservation(uuid(), 50, 0),
      purpose: "read_only_review" as const,
    };
    const reviewLease = await service.reserveUsage(
      reviewer,
      seeded.teamId,
      projectId,
      reviewRequest,
      mutation(uuid(), "ai-reviewer-readonly-key-01"),
    );
    expect(reviewLease.reservation.purpose).toBe("read_only_review");
    await expect(
      service.cancelUsage(
        reviewer,
        seeded.teamId,
        projectId,
        reviewLease.reservation.reservationId,
        { schemaVersion: CONTRACT_SCHEMA_VERSION, expectedRevision: 1 },
        mutation(uuid(), "ai-reviewer-own-cancel-key"),
      ),
    ).resolves.toMatchObject({ reservation: { state: "cancelled" } });
    await expect(
      service.cancelUsage(
        owner,
        seeded.teamId,
        projectId,
        authorLease.reservation.reservationId,
        { schemaVersion: CONTRACT_SCHEMA_VERSION, expectedRevision: 1 },
        mutation(uuid(), "ai-owner-managed-cancel-key"),
      ),
    ).resolves.toMatchObject({ reservation: { state: "cancelled" } });
  });

  it("denies same-tenant cross-team project authority for owner, admin, finance and direct RLS writes", async () => {
    const owner = await seedPrincipal(adminPool, uuid, "ai-cross-team-owner");
    const admin = await seedPrincipal(adminPool, uuid, "ai-cross-team-admin");
    const finance = await seedPrincipal(adminPool, uuid, "ai-cross-team-finance");
    const firstTeam = await seedTeamProjects(adminPool, uuid, owner, 1);
    const secondTeam = await seedTeamProjects(adminPool, uuid, owner, 1);
    await seedMembership(
      adminPool,
      uuid,
      owner.accountId,
      firstTeam.teamId,
      admin.accountId,
      "admin",
    );
    await seedMembership(
      adminPool,
      uuid,
      owner.accountId,
      firstTeam.teamId,
      finance.accountId,
      "finance_admin",
    );
    const initialBudget = await service.updateTeamBudget(
      owner,
      firstTeam.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        currency: "AUD",
        monthlyLimitMicrounits: 10_000,
        priceVersion: "aud-2026-01",
        inputMicrounitsPerMillionTokens: 1_000_000,
        outputMicrounitsPerMillionTokens: 2_000_000,
        maximumConcurrentRuns: 2,
      },
      mutation(uuid(), "ai-cross-team-budget-key-01"),
    );
    const adminBudget = await service.updateTeamBudget(
      admin,
      firstTeam.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: initialBudget.budget.revision,
        currency: "AUD",
        monthlyLimitMicrounits: 20_000,
        priceVersion: "aud-2026-01-r2",
        inputMicrounitsPerMillionTokens: 1_100_000,
        outputMicrounitsPerMillionTokens: 2_100_000,
        maximumConcurrentRuns: 3,
      },
      mutation(uuid(), "ai-admin-team-budget-key-01"),
    );
    await expect(
      service.updateTeamBudget(
        finance,
        firstTeam.teamId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: adminBudget.budget.revision,
          currency: "AUD",
          monthlyLimitMicrounits: 30_000,
          priceVersion: "aud-2026-01-r3",
          inputMicrounitsPerMillionTokens: 1_100_000,
          outputMicrounitsPerMillionTokens: 2_100_000,
          maximumConcurrentRuns: 3,
        },
        mutation(uuid(), "ai-finance-team-budget-deny"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    const financeProjectBudget = await service.updateProjectBudget(
      finance,
      firstTeam.teamId,
      firstTeam.projectIds[0] ?? "",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        monthlyLimitMicrounits: 5_000,
        maximumConcurrentRuns: 1,
      },
      mutation(uuid(), "ai-finance-project-budget-ok"),
    );
    expect(financeProjectBudget.budget.revision).toBe(1);
    const financeSummary = await service.getUsageSummary(
      finance,
      firstTeam.teamId,
      firstTeam.projectIds[0] ?? "",
      read(uuid()),
    );
    expect(financeSummary.capabilities).toEqual({
      manageTeamBudget: false,
      manageProjectBudget: true,
      consume: false,
    });
    const foreignProjectId = secondTeam.projectIds[0] ?? "";
    for (const [actor, suffix] of [
      [owner, "owner"],
      [admin, "admin"],
      [finance, "finance"],
    ] as const) {
      await expect(
        service.getUsageSummary(actor, firstTeam.teamId, foreignProjectId, read(uuid())),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      await expect(
        service.updateProjectBudget(
          actor,
          firstTeam.teamId,
          foreignProjectId,
          {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            expectedRevision: null,
            monthlyLimitMicrounits: 1_000,
            maximumConcurrentRuns: 1,
          },
          mutation(uuid(), `ai-cross-team-project-${suffix}`),
        ),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    }

    const firstTeamIdempotency = await adminPool.query<{
      idempotency_key_hash_sha256: string;
    }>(
      `SELECT idempotency_key_hash_sha256
       FROM cloud_ai_usage_idempotency
       WHERE actor_account_id = $1
         AND tenant_id = $1
         AND team_id = $2
         AND operation_id = 'aiBudgets.updateTeam'
       ORDER BY created_at
       LIMIT 1`,
      [owner.accountId, firstTeam.teamId],
    );
    const firstTeamIdempotencyHash = firstTeamIdempotency.rows[0]?.idempotency_key_hash_sha256;
    if (firstTeamIdempotencyHash === undefined) {
      throw new Error("The first-team idempotency receipt was not persisted.");
    }

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('inkshadow.account_id', $1, true)", [owner.accountId]);
      await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [owner.accountId]);
      await client.query("SELECT set_config('inkshadow.team_id', $1, true)", [firstTeam.teamId]);
      await expect(
        client.query(
          `INSERT INTO cloud_ai_project_budgets (
             tenant_id, team_id, project_id, monthly_limit_microunits,
             maximum_concurrent_runs, revision, updated_by_membership_id,
             created_at, updated_at
           ) VALUES ($1, $2, $3, 1000, 1, 1, $4, $5, $5)`,
          [owner.accountId, firstTeam.teamId, foreignProjectId, firstTeam.membershipId, now],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SELECT set_config('inkshadow.account_id', $1, true)", [owner.accountId]);
      await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [owner.accountId]);
      await client.query("SELECT set_config('inkshadow.team_id', $1, true)", [secondTeam.teamId]);
      const crossedReceipt = await client.query(
        `SELECT response_snapshot
         FROM cloud_ai_usage_idempotency
         WHERE idempotency_key_hash_sha256 = $1`,
        [firstTeamIdempotencyHash],
      );
      expect(crossedReceipt.rows).toEqual([]);
      const crossedDelete = await client.query(
        `DELETE FROM cloud_ai_usage_idempotency
         WHERE idempotency_key_hash_sha256 = $1`,
        [firstTeamIdempotencyHash],
      );
      expect(crossedDelete.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("does not treat a stale assignment owned by a revoked member as team-project authority", async () => {
    const owner = await seedPrincipal(adminPool, uuid, "ai-stale-owner");
    const author = await seedPrincipal(adminPool, uuid, "ai-stale-author");
    const seeded = await seedTeamProjects(adminPool, uuid, owner, 1);
    const projectId = seeded.projectIds[0] ?? "";
    const authorMembershipId = await seedMembership(
      adminPool,
      uuid,
      owner.accountId,
      seeded.teamId,
      author.accountId,
      "author",
    );
    await adminPool.query(
      `UPDATE cloud_project_assignments
       SET state = 'revoked',
           revision = revision + 1,
           revoked_by_membership_id = $4,
           revoked_at = $5,
           updated_at = $5
       WHERE tenant_id = $1
         AND team_id = $2
         AND project_id = $3
         AND membership_id = $4`,
      [owner.accountId, seeded.teamId, projectId, seeded.membershipId, now],
    );
    await adminPool.query(
      `INSERT INTO cloud_project_assignments (
         tenant_id, team_id, project_id, membership_id, assignment_id,
         state, revision, granted_by_membership_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $7, $7)`,
      [
        owner.accountId,
        seeded.teamId,
        projectId,
        authorMembershipId,
        uuid(),
        seeded.membershipId,
        now,
      ],
    );
    await adminPool.query(
      `UPDATE cloud_team_memberships
       SET state = 'revoked',
           revision = revision + 1,
           revoked_at = $4,
           updated_at = $4
       WHERE tenant_id = $1
         AND team_id = $2
         AND membership_id = $3`,
      [owner.accountId, seeded.teamId, authorMembershipId, now],
    );

    await expect(
      service.getUsageSummary(owner, seeded.teamId, projectId, read(uuid())),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('inkshadow.account_id', $1, true)", [owner.accountId]);
      await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [owner.accountId]);
      await client.query("SELECT set_config('inkshadow.team_id', $1, true)", [seeded.teamId]);
      await expect(
        client.query(
          `INSERT INTO cloud_ai_project_budgets (
             tenant_id, team_id, project_id, monthly_limit_microunits,
             maximum_concurrent_runs, revision, updated_by_membership_id,
             created_at, updated_at
           ) VALUES ($1, $2, $3, 1000, 1, 1, $4, $5, $5)`,
          [owner.accountId, seeded.teamId, projectId, seeded.membershipId, now],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("reclaims a Jan-31 lease in February, bounds metadata and permits only expired idempotency deletion", async () => {
    now = new Date("2026-01-31T23:59:45.000Z");
    const owner = await seedPrincipal(adminPool, uuid, "ai-month-owner");
    const seeded = await seedTeamProjects(adminPool, uuid, owner, 1);
    await service.updateTeamBudget(
      owner,
      seeded.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        currency: "AUD",
        monthlyLimitMicrounits: 10_000,
        priceVersion: "aud-2026-01",
        inputMicrounitsPerMillionTokens: 1_000_000,
        outputMicrounitsPerMillionTokens: 2_000_000,
        maximumConcurrentRuns: 1,
      },
      mutation(uuid(), "ai-month-budget-key-00001"),
    );
    const request = reservation(uuid(), 500, 0, 30);
    await service.reserveUsage(
      owner,
      seeded.teamId,
      seeded.projectIds[0] ?? "",
      request,
      mutation(uuid(), "ai-month-boundary-key-001"),
    );
    now = new Date("2026-02-01T00:00:20.000Z");
    const summary = await service.getUsageSummary(
      owner,
      seeded.teamId,
      seeded.projectIds[0] ?? "",
      read(uuid()),
    );
    expect(summary.leaseExpiredCount).toBe(1);
    expect(summary.activeLeaseCount).toBe(0);
    const january = await adminPool.query<{
      reserved_microunits: string;
      reserved_input_tokens: string;
    }>(
      `SELECT reserved_microunits, reserved_input_tokens
       FROM cloud_ai_team_usage_months
       WHERE tenant_id = $1
         AND team_id = $2
         AND period_start = DATE '2026-01-01'`,
      [owner.accountId, seeded.teamId],
    );
    expect(january.rows).toEqual([{ reserved_input_tokens: "0", reserved_microunits: "0" }]);
    const metadataColumns = await adminPool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name IN (
         'cloud_ai_usage_events',
         'cloud_ai_usage_idempotency',
         'cloud_ai_usage_reservations'
       )
         AND column_name IN (
           'content',
           'prompt',
           'plaintext',
           'ciphertext',
           'private_key',
           'raw_project_data_key'
         )`,
    );
    expect(metadataColumns.rows).toEqual([]);
    const guardedIdempotencyHash = createHash("sha256")
      .update(`guarded-ai-idempotency:${uuid()}`)
      .digest("hex");
    const emptySnapshotDigest = createHash("sha256").update("{}").digest("hex");
    await adminPool.query(
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
       ) VALUES (
         $1, $2, 'aiBudgets.updateTeam', $2, $3, NULL, $3, $4, 1, $5, '{}'::jsonb,
         clock_timestamp(), clock_timestamp() + INTERVAL '1 day'
       )`,
      [guardedIdempotencyHash, owner.accountId, seeded.teamId, "f".repeat(64), emptySnapshotDigest],
    );

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('inkshadow.account_id', $1, true)", [owner.accountId]);
      await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [owner.accountId]);
      await client.query("SELECT set_config('inkshadow.team_id', $1, true)", [seeded.teamId]);
      await expect(
        client.query(
          `UPDATE cloud_ai_usage_events
           SET cost_microunits = cost_microunits + 1
           WHERE reservation_id = $1`,
          [request.reservationId],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SELECT set_config('inkshadow.account_id', $1, true)", [owner.accountId]);
      await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [owner.accountId]);
      await client.query("SELECT set_config('inkshadow.team_id', $1, true)", [seeded.teamId]);
      const currentDelete = await client.query(
        `DELETE FROM cloud_ai_usage_idempotency
         WHERE idempotency_key_hash_sha256 = $1`,
        [guardedIdempotencyHash],
      );
      expect(currentDelete.rowCount).toBe(0);
      const immutableUpdate = await client.query(
        `UPDATE cloud_ai_usage_idempotency
         SET response_snapshot = '{"tampered":true}'::jsonb
         WHERE idempotency_key_hash_sha256 = $1`,
        [guardedIdempotencyHash],
      );
      expect(immutableUpdate.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const switchedCurrency = await service.updateTeamBudget(
      owner,
      seeded.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: 1,
        currency: "USD",
        monthlyLimitMicrounits: 10_000,
        priceVersion: "usd-2026-02",
        inputMicrounitsPerMillionTokens: 1_000_000,
        outputMicrounitsPerMillionTokens: 2_000_000,
        maximumConcurrentRuns: 1,
      },
      mutation(uuid(), "ai-next-month-currency-key-1"),
    );
    expect(switchedCurrency.budget.currency).toBe("USD");

    now = new Date("2026-02-02T00:00:21.000Z");
    const reused = reservation(uuid(), 100, 0, 300, "usd-2026-02");
    await expect(
      service.reserveUsage(
        owner,
        seeded.teamId,
        seeded.projectIds[0] ?? "",
        reused,
        mutation(uuid(), "ai-month-boundary-key-001"),
      ),
    ).resolves.toMatchObject({
      reservation: { reservationId: reused.reservationId, state: "active" },
    });
  });

  it("isolates AI usage rows by exact tenant/team for a non-bypass application role", async () => {
    const first = await seedPrincipal(adminPool, uuid, "ai-rls-first");
    const second = await seedPrincipal(adminPool, uuid, "ai-rls-second");
    const firstScope = await seedTeamProjects(adminPool, uuid, first, 1);
    const secondScope = await seedTeamProjects(adminPool, uuid, second, 1);
    for (const [principal, scope, key] of [
      [first, firstScope, "ai-rls-budget-key-first"],
      [second, secondScope, "ai-rls-budget-key-second"],
    ] as const) {
      await service.updateTeamBudget(
        principal,
        scope.teamId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: null,
          currency: "AUD",
          monthlyLimitMicrounits: 10_000,
          priceVersion: "aud-2026-02",
          inputMicrounitsPerMillionTokens: 1_000_000,
          outputMicrounitsPerMillionTokens: 2_000_000,
          maximumConcurrentRuns: 2,
        },
        mutation(uuid(), key),
      );
    }
    const client = await appPool.connect();
    try {
      expect(
        (
          await client.query<{ assigned: boolean }>(
            "SELECT inkshadow_team_has_active_project_assignment($1, $2, $3) AS assigned",
            [first.accountId, firstScope.teamId, firstScope.projectIds[0]],
          )
        ).rows[0]?.assigned,
      ).toBe(false);
      await client.query("BEGIN");
      await client.query("SELECT set_config('inkshadow.account_id', $1, true)", [first.accountId]);
      await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [first.accountId]);
      await client.query("SELECT set_config('inkshadow.team_id', $1, true)", [firstScope.teamId]);
      expect(
        (
          await client.query<{ assigned: boolean }>(
            "SELECT inkshadow_team_has_active_project_assignment($1, $2, $3) AS assigned",
            [first.accountId, firstScope.teamId, firstScope.projectIds[0]],
          )
        ).rows[0]?.assigned,
      ).toBe(true);
      expect(
        (
          await client.query<{ assigned: boolean }>(
            "SELECT inkshadow_team_has_active_project_assignment($1, $2, $3) AS assigned",
            [second.accountId, secondScope.teamId, secondScope.projectIds[0]],
          )
        ).rows[0]?.assigned,
      ).toBe(false);
      expect((await client.query("SELECT team_id FROM cloud_ai_team_budgets")).rows).toEqual([
        { team_id: firstScope.teamId },
      ]);
      const crossScope = await client.query(
        `UPDATE cloud_ai_team_budgets
         SET monthly_limit_microunits = monthly_limit_microunits + 1
         WHERE tenant_id = $1
           AND team_id = $2`,
        [second.accountId, secondScope.teamId],
      );
      expect(crossScope.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

interface SeededPrincipal extends CloudPrincipal {
  readonly email: string;
}

interface SeededTeamProjects {
  readonly teamId: string;
  readonly membershipId: string;
  readonly projectIds: readonly string[];
}

async function seedPrincipal(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  label: string,
): Promise<SeededPrincipal> {
  const accountId = uuid();
  const deviceId = uuid();
  const sessionId = uuid();
  const email = `${label}-${accountId}@example.test`;
  await pool.query(
    `INSERT INTO cloud_accounts (
       account_id, email_canonical, password_hash, state, verified_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'active', $4, $4, $4)`,
    [accountId, email, `scrypt-test-${"x".repeat(32)}`, now],
  );
  await pool.query(
    `INSERT INTO registered_devices (
       device_id, account_id, display_name, algorithm, public_key,
       public_key_fingerprint, client_version, state, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'DHKEM-P256-HKDF-SHA256', $4, $5,
       '0.1.0', 'trusted', $6, $6
     )`,
    [deviceId, accountId, `${label} device`, "A".repeat(87), sha256(deviceId), now],
  );
  await pool.query(
    `INSERT INTO cloud_sessions (
       session_id, account_id, device_id, client_version, minimum_client_version,
       access_token_hash_sha256, refresh_token_hash_sha256, refresh_generation,
       issued_at, expires_at, refresh_expires_at, last_seen_at
     ) VALUES (
       $1, $2, $3, '0.1.0', '0.1.0', $4, $5, 1,
       $6, $7, $8, $6
     )`,
    [
      sessionId,
      accountId,
      deviceId,
      sha256(`access-${sessionId}`),
      sha256(`refresh-${sessionId}`),
      now,
      new Date(now.getTime() + 200 * 24 * 60 * 60 * 1_000),
      new Date(now.getTime() + 400 * 24 * 60 * 60 * 1_000),
    ],
  );
  return { accountId, deviceId, email, sessionId };
}

async function seedTeamProjects(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  owner: SeededPrincipal,
  projectCount: number,
): Promise<SeededTeamProjects> {
  const teamId = uuid();
  const membershipId = uuid();
  const projectIds = Array.from({ length: projectCount }, () => uuid());
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO cloud_teams (
         tenant_id, team_id, display_name, state, revision, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', 1, $4, $4)`,
      [owner.accountId, teamId, `AI team ${teamId}`, now],
    );
    await client.query(
      `INSERT INTO cloud_team_memberships (
         tenant_id, team_id, membership_id, account_id, role, state,
         revision, created_at, updated_at
       ) VALUES ($1, $2, $3, $1, 'owner', 'active', 1, $4, $4)`,
      [owner.accountId, teamId, membershipId, now],
    );
    for (const projectId of projectIds) {
      await client.query(
        `INSERT INTO cloud_projects (
           tenant_id, project_id, owner_account_id, state, revision, created_at, updated_at
         ) VALUES ($1, $2, $1, 'active', 1, $3, $3)`,
        [owner.accountId, projectId, now],
      );
      await client.query(
        `INSERT INTO cloud_project_assignments (
           tenant_id, team_id, project_id, membership_id, assignment_id,
           state, revision, granted_by_membership_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', 1, $4, $6, $6)`,
        [owner.accountId, teamId, projectId, membershipId, uuid(), now],
      );
    }
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { membershipId, projectIds, teamId };
}

async function seedMembership(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  tenantId: string,
  teamId: string,
  accountId: string,
  role: "admin" | "author" | "finance_admin" | "reviewer",
): Promise<string> {
  const membershipId = uuid();
  await pool.query(
    `INSERT INTO cloud_team_memberships (
       tenant_id, team_id, membership_id, account_id, role, state,
       revision, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $6)`,
    [tenantId, teamId, membershipId, accountId, role, now],
  );
  return membershipId;
}

async function seedAssignment(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  tenantId: string,
  teamId: string,
  projectId: string,
  membershipId: string,
  grantedByMembershipId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO cloud_project_assignments (
       tenant_id, team_id, project_id, membership_id, assignment_id,
       state, revision, granted_by_membership_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $7, $7)`,
    [tenantId, teamId, projectId, membershipId, uuid(), grantedByMembershipId, now],
  );
}

function reservation(
  reservationId: string,
  inputTokens: number,
  outputTokens: number,
  leaseTtlSeconds = 300,
  priceVersion = "aud-2026-01",
) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    reservationId,
    modelIdentifier: "openai/gpt-5",
    purpose: "content_generation",
    priceVersion,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    leaseTtlSeconds,
  } as const;
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
