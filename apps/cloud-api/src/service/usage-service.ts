import { authorizeTeamAction, type TeamMembership } from "@inkshadow/access-core";
import {
  CloudAiProjectBudgetResponseSchema,
  CloudAiTeamBudgetResponseSchema,
  CloudAiUsageEventListResponseSchema,
  CloudAiUsageReservationResponseSchema,
  CloudAiUsageSummaryResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudAiProjectBudget,
  type CloudAiProjectBudgetResponse,
  type CloudAiProjectBudgetUpdateRequest,
  type CloudAiTeamBudget,
  type CloudAiTeamBudgetResponse,
  type CloudAiTeamBudgetUpdateRequest,
  type CloudAiUsageBucket,
  type CloudAiUsageCancellationRequest,
  type CloudAiUsageEvent,
  type CloudAiUsageEventListResponse,
  type CloudAiUsageReservation,
  type CloudAiUsageReservationRequest,
  type CloudAiUsageReservationResponse,
  type CloudAiUsageSettlementRequest,
  type CloudAiUsageSummaryResponse,
  type CloudApiOperationId,
} from "@inkshadow/contracts";

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
import { hashCanonicalJson, hashUtf8 } from "../security/canonical-hash.js";
import { InvalidPageCursorError } from "../security/page-cursor.js";
import type { CloudPageCursorCodec } from "../security/page-cursor.js";
import type { UuidV7Factory } from "../security/uuid-v7.js";
import {
  accessForbidden,
  aiBudgetCurrencyLocked,
  aiBudgetHardCap,
  aiBudgetNotConfigured,
  aiConcurrencyHardCap,
  aiPriceVersionMismatch,
  aiReservationExpired,
  aiReservationStateConflict,
  idempotencyConflict,
  resourceNotFound,
  revisionConflict,
  sessionExpired,
  validationFailed,
  type CloudServiceError,
} from "./errors.js";
import type { CloudMutationContext, CloudPrincipal, CloudReadContext } from "./identity-service.js";

const DEFAULT_IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const PRICE_TOKEN_DENOMINATOR = 1_000_000n;
const MAXIMUM_PAGE_SIZE = 100;
const MAXIMUM_EXPIRED_LEASE_BATCH = 1_000;

interface TeamScope {
  readonly actor: CloudTeamMembershipRecord;
  readonly team: CloudTeamRecord;
}

interface ProjectScope extends TeamScope {
  readonly assignment: CloudProjectAssignmentRecord | null;
  readonly project: CloudProjectRecord;
}

type UsageMutationOperation = Extract<
  CloudApiOperationId,
  | "aiBudgets.updateTeam"
  | "aiBudgets.updateProject"
  | "aiUsage.reserve"
  | "aiUsage.settle"
  | "aiUsage.cancel"
>;

type MutationOutcome<Output> = { readonly value: Output } | { readonly error: CloudServiceError };

export interface CloudAiUsageServiceOptions {
  readonly clock?: () => Date;
  readonly idempotencyLifetimeMs?: number;
  readonly pageCursorCodec: CloudPageCursorCodec;
  readonly store: CloudAiUsageStore;
  readonly uuid: UuidV7Factory;
}

export class CloudAiUsageService {
  private readonly clock: () => Date;
  private readonly idempotencyLifetimeMs: number;
  private readonly pageCursorCodec: CloudPageCursorCodec;
  private readonly store: CloudAiUsageStore;
  private readonly uuid: UuidV7Factory;

  public constructor(options: CloudAiUsageServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.idempotencyLifetimeMs = options.idempotencyLifetimeMs ?? DEFAULT_IDEMPOTENCY_LIFETIME_MS;
    this.pageCursorCodec = options.pageCursorCodec;
    this.store = options.store;
    this.uuid = options.uuid;
    if (!Number.isSafeInteger(this.idempotencyLifetimeMs) || this.idempotencyLifetimeMs <= 0) {
      throw new Error("The AI usage idempotency lifetime must be a positive portable integer.");
    }
  }

  public async updateTeamBudget(
    principal: CloudPrincipal,
    teamId: string,
    request: CloudAiTeamBudgetUpdateRequest,
    context: CloudMutationContext,
  ): Promise<CloudAiTeamBudgetResponse> {
    const now = this.now();
    const requestHash = hashCanonicalJson({ request, teamId });
    const outcome = await this.store.transaction<MutationOutcome<CloudAiTeamBudgetResponse>>(
      async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        const scope = await this.requireTeamScope(transaction, principal, teamId);
        this.requireBillingAction(scope, "billing.manage");
        if (scope.actor.role === "finance_admin") {
          throw accessForbidden();
        }
        const replay = await this.findIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "aiBudgets.updateTeam",
          projectId: null,
          requestHash,
          resourceId: teamId,
          scope,
        });
        if (replay !== null) {
          return {
            value: replayTeamBudgetResponse(replay, scope.team.tenantId, teamId, context.requestId),
          };
        }

        await transaction.lockBudgetScope(scope.team.tenantId, teamId, null);
        const existing = await transaction.findTeamBudget(scope.team.tenantId, teamId, true);
        if (
          (existing === null && request.expectedRevision !== null) ||
          (existing !== null && request.expectedRevision !== existing.revision)
        ) {
          return { error: revisionConflict() };
        }
        const periodStart = monthStart(now);
        const usage = await transaction.getOrCreateTeamUsageMonth(
          scope.team.tenantId,
          teamId,
          periodStart,
          now,
          true,
        );
        const used = safeAdd(usage.settledMicrounits, usage.reservedMicrounits);
        if (
          existing !== null &&
          request.currency !== existing.currency &&
          (hasUsage(usage) ||
            (await transaction.countActiveReservations(scope.team.tenantId, teamId, now)) > 0)
        ) {
          return { error: aiBudgetCurrencyLocked() };
        }
        if (request.monthlyLimitMicrounits < used) {
          return { error: aiBudgetHardCap() };
        }
        const revision = nextRevision(existing?.revision ?? 0);
        const record: CloudAiTeamBudgetRecord = {
          tenantId: scope.team.tenantId,
          teamId,
          currency: request.currency,
          monthlyLimitMicrounits: request.monthlyLimitMicrounits,
          warningThresholdBasisPoints: 8_000,
          hardCap: true,
          priceVersion: request.priceVersion,
          inputMicrounitsPerMillionTokens: request.inputMicrounitsPerMillionTokens,
          outputMicrounitsPerMillionTokens: request.outputMicrounitsPerMillionTokens,
          maximumConcurrentRuns: request.maximumConcurrentRuns,
          revision,
          updatedByMembershipId: scope.actor.membershipId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        if (existing === null) {
          await transaction.insertTeamBudget(record);
        } else if (!(await transaction.updateTeamBudgetCas(record, existing.revision))) {
          return { error: revisionConflict() };
        }
        const response = teamBudgetResponse(record, context.requestId);
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "aiBudgets.updateTeam",
          projectId: null,
          requestHash,
          resourceId: teamId,
          resultRevision: revision,
          responseSnapshot: response,
          scope,
        });
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async updateProjectBudget(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    request: CloudAiProjectBudgetUpdateRequest,
    context: CloudMutationContext,
  ): Promise<CloudAiProjectBudgetResponse> {
    const now = this.now();
    const requestHash = hashCanonicalJson({ projectId, request, teamId });
    const outcome = await this.store.transaction<MutationOutcome<CloudAiProjectBudgetResponse>>(
      async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        const scope = await this.requireProjectScope(transaction, principal, teamId, projectId);
        this.requireBillingAction(scope, "billing.manage");
        const replay = await this.findIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "aiBudgets.updateProject",
          projectId,
          requestHash,
          resourceId: projectId,
          scope,
        });
        if (replay !== null) {
          return {
            value: replayProjectBudgetResponse(
              replay,
              scope.team.tenantId,
              teamId,
              projectId,
              context.requestId,
            ),
          };
        }
        await transaction.lockBudgetScope(scope.team.tenantId, teamId, projectId);
        if ((await transaction.findTeamBudget(scope.team.tenantId, teamId, true)) === null) {
          return { error: aiBudgetNotConfigured() };
        }
        const existing = await transaction.findProjectBudget(
          scope.team.tenantId,
          teamId,
          projectId,
          true,
        );
        if (
          (existing === null && request.expectedRevision !== null) ||
          (existing !== null && request.expectedRevision !== existing.revision)
        ) {
          return { error: revisionConflict() };
        }
        const periodStart = monthStart(now);
        const usage = await transaction.getOrCreateProjectUsageMonth(
          scope.team.tenantId,
          teamId,
          projectId,
          periodStart,
          now,
          true,
        );
        const used = safeAdd(usage.settledMicrounits, usage.reservedMicrounits);
        if (request.monthlyLimitMicrounits !== null && request.monthlyLimitMicrounits < used) {
          return { error: aiBudgetHardCap() };
        }
        const revision = nextRevision(existing?.revision ?? 0);
        const record: CloudAiProjectBudgetRecord = {
          tenantId: scope.team.tenantId,
          teamId,
          projectId,
          monthlyLimitMicrounits: request.monthlyLimitMicrounits,
          maximumConcurrentRuns: request.maximumConcurrentRuns,
          revision,
          updatedByMembershipId: scope.actor.membershipId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        if (existing === null) {
          await transaction.insertProjectBudget(record);
        } else if (!(await transaction.updateProjectBudgetCas(record, existing.revision))) {
          return { error: revisionConflict() };
        }
        const response = projectBudgetResponse(record, context.requestId);
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "aiBudgets.updateProject",
          projectId,
          requestHash,
          resourceId: projectId,
          resultRevision: revision,
          responseSnapshot: response,
          scope,
        });
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async getUsageSummary(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string | null,
    context: CloudReadContext,
  ): Promise<CloudAiUsageSummaryResponse> {
    const now = this.now();
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, now);
      const scope =
        projectId === null
          ? await this.requireTeamScope(transaction, principal, teamId)
          : await this.requireProjectScope(transaction, principal, teamId, projectId);
      const includeTeam = this.authorizeUsageRead(scope, projectId);
      const teamBudget = await transaction.findTeamBudget(scope.team.tenantId, teamId, true);
      const periodStart = monthStart(now);
      const expiredCount =
        teamBudget === null
          ? 0
          : await this.reclaimExpiredLeases(transaction, scope, now, context.requestId);
      return this.buildSummary(transaction, {
        context,
        expiredCount,
        includeTeam,
        now,
        periodStart,
        projectId,
        scope,
        teamBudget,
      });
    });
  }

  public async listUsageEvents(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string | null,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudAiUsageEventListResponse> {
    const pageSize = requirePageSize(limit);
    const anchor = this.decodeCursor(cursor);
    const now = this.now();
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, now);
      const scope =
        projectId === null
          ? await this.requireTeamScope(transaction, principal, teamId)
          : await this.requireProjectScope(transaction, principal, teamId, projectId);
      this.authorizeUsageRead(scope, projectId);
      const page = await transaction.listUsageEvents(
        scope.team.tenantId,
        teamId,
        projectId,
        pageSize + 1,
        anchor,
      );
      const events = page.slice(0, pageSize);
      const next = page.length > pageSize ? (events.at(-1) ?? null) : null;
      return CloudAiUsageEventListResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        tenantId: scope.team.tenantId,
        teamId,
        projectId,
        events: events.map(toUsageEvent),
        nextCursor:
          next === null
            ? null
            : this.pageCursorCodec.encode("ai_usage_events", {
                createdAt: next.createdAt,
                id: next.eventId,
              }),
      });
    });
  }

  public async reserveUsage(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    request: CloudAiUsageReservationRequest,
    context: CloudMutationContext,
  ): Promise<CloudAiUsageReservationResponse> {
    const now = this.now();
    const requestHash = hashCanonicalJson({ projectId, request, teamId });
    const outcome = await this.store.transaction<MutationOutcome<CloudAiUsageReservationResponse>>(
      async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        const scope = await this.requireProjectScope(transaction, principal, teamId, projectId);
        this.requireConsumption(scope, request.purpose);
        const replay = await this.findIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "aiUsage.reserve",
          projectId,
          requestHash,
          resourceId: request.reservationId,
          scope,
        });
        if (replay !== null) {
          return {
            value: replayReservationResponse(
              replay,
              scope.team.tenantId,
              teamId,
              projectId,
              request.reservationId,
              "active",
              context.requestId,
            ),
          };
        }

        const teamBudget = await transaction.findTeamBudget(scope.team.tenantId, teamId, true);
        if (teamBudget === null) {
          return { error: aiBudgetNotConfigured() };
        }
        if (teamBudget.priceVersion !== request.priceVersion) {
          return { error: aiPriceVersionMismatch() };
        }
        const periodStart = monthStart(now);
        const expiredCount = await this.reclaimExpiredLeases(
          transaction,
          scope,
          now,
          context.requestId,
        );
        const refreshedTeamUsage = await transaction.getOrCreateTeamUsageMonth(
          scope.team.tenantId,
          teamId,
          periodStart,
          now,
          true,
        );
        const activeLeaseCount = await transaction.countActiveReservations(
          scope.team.tenantId,
          teamId,
          now,
        );
        if (activeLeaseCount >= teamBudget.maximumConcurrentRuns) {
          return { error: aiConcurrencyHardCap() };
        }
        const projectBudget = await transaction.findProjectBudget(
          scope.team.tenantId,
          teamId,
          projectId,
          true,
        );
        const activeProjectLeaseCount = await transaction.countActiveProjectReservations(
          scope.team.tenantId,
          teamId,
          projectId,
          now,
        );
        if (
          projectBudget?.maximumConcurrentRuns !== null &&
          projectBudget?.maximumConcurrentRuns !== undefined &&
          activeProjectLeaseCount >= projectBudget.maximumConcurrentRuns
        ) {
          return { error: aiConcurrencyHardCap() };
        }
        const projectUsage = await transaction.getOrCreateProjectUsageMonth(
          scope.team.tenantId,
          teamId,
          projectId,
          periodStart,
          now,
          true,
        );
        const cost = tokenCost(
          request.estimatedInputTokens,
          request.estimatedOutputTokens,
          teamBudget.inputMicrounitsPerMillionTokens,
          teamBudget.outputMicrounitsPerMillionTokens,
        );
        if (
          wouldExceed(
            refreshedTeamUsage.settledMicrounits,
            refreshedTeamUsage.reservedMicrounits,
            cost,
            teamBudget.monthlyLimitMicrounits,
          ) ||
          (projectBudget?.monthlyLimitMicrounits != null &&
            wouldExceed(
              projectUsage.settledMicrounits,
              projectUsage.reservedMicrounits,
              cost,
              projectBudget.monthlyLimitMicrounits,
            ))
        ) {
          return { error: aiBudgetHardCap() };
        }
        if (
          (await transaction.findReservation(
            scope.team.tenantId,
            teamId,
            projectId,
            request.reservationId,
            true,
          )) !== null
        ) {
          return { error: aiReservationStateConflict() };
        }
        const reservation: CloudAiUsageReservationRecord = {
          tenantId: scope.team.tenantId,
          teamId,
          projectId,
          reservationId: request.reservationId,
          membershipId: scope.actor.membershipId,
          modelIdentifier: request.modelIdentifier,
          purpose: request.purpose,
          priceVersion: teamBudget.priceVersion,
          currency: teamBudget.currency,
          state: "active",
          reservedInputTokens: request.estimatedInputTokens,
          reservedOutputTokens: request.estimatedOutputTokens,
          reservedMicrounits: cost,
          inputMicrounitsPerMillionTokens: teamBudget.inputMicrounitsPerMillionTokens,
          outputMicrounitsPerMillionTokens: teamBudget.outputMicrounitsPerMillionTokens,
          settledInputTokens: 0,
          settledOutputTokens: 0,
          settledMicrounits: 0,
          revision: 1,
          requestHashSha256: requestHash,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + request.leaseTtlSeconds * 1_000),
          settledAt: null,
          cancelledAt: null,
          expiredAt: null,
        };
        await transaction.insertReservation(reservation);
        await transaction.updateTeamUsageMonth(
          addReservation(refreshedTeamUsage, reservation, now),
        );
        await transaction.updateProjectUsageMonth(addReservation(projectUsage, reservation, now));
        await transaction.insertUsageEvent(
          usageEvent(reservation, "reserved", context.requestId, this.uuid(), now),
        );
        const response = await this.reservationResponse(
          transaction,
          scope,
          reservation,
          context,
          now,
          expiredCount,
        );
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "aiUsage.reserve",
          projectId,
          requestHash,
          resourceId: reservation.reservationId,
          resultRevision: reservation.revision,
          responseSnapshot: response,
          scope,
        });
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public settleUsage(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    reservationId: string,
    request: CloudAiUsageSettlementRequest,
    context: CloudMutationContext,
  ): Promise<CloudAiUsageReservationResponse> {
    return this.finishReservation(
      "settle",
      principal,
      teamId,
      projectId,
      reservationId,
      request,
      context,
    );
  }

  public cancelUsage(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    reservationId: string,
    request: CloudAiUsageCancellationRequest,
    context: CloudMutationContext,
  ): Promise<CloudAiUsageReservationResponse> {
    return this.finishReservation(
      "cancel",
      principal,
      teamId,
      projectId,
      reservationId,
      request,
      context,
    );
  }

  private async finishReservation(
    kind: "settle" | "cancel",
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    reservationId: string,
    request: CloudAiUsageSettlementRequest | CloudAiUsageCancellationRequest,
    context: CloudMutationContext,
  ): Promise<CloudAiUsageReservationResponse> {
    const operationId = kind === "settle" ? "aiUsage.settle" : "aiUsage.cancel";
    const now = this.now();
    const requestHash = hashCanonicalJson({ projectId, request, reservationId, teamId });
    const outcome = await this.store.transaction<MutationOutcome<CloudAiUsageReservationResponse>>(
      async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        const scope = await this.requireProjectScope(transaction, principal, teamId, projectId);
        const replay = await this.findIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId,
          projectId,
          requestHash,
          resourceId: reservationId,
          scope,
        });
        if (replay !== null) {
          const expectedState = kind === "settle" ? "settled" : "cancelled";
          const response = replayReservationResponse(
            replay,
            scope.team.tenantId,
            teamId,
            projectId,
            reservationId,
            expectedState,
            context.requestId,
          );
          this.requireConsumption(scope, response.reservation.purpose);
          this.requireReservationOwnership(scope, response.reservation);
          return {
            value: response,
          };
        }
        const teamBudget = await transaction.findTeamBudget(scope.team.tenantId, teamId, true);
        if (teamBudget === null) {
          return { error: aiBudgetNotConfigured() };
        }
        const reservation = await transaction.findReservation(
          scope.team.tenantId,
          teamId,
          projectId,
          reservationId,
          true,
        );
        if (reservation === null) {
          return { error: resourceNotFound() };
        }
        this.requireConsumption(scope, reservation.purpose);
        this.requireReservationOwnership(scope, reservation);
        if (reservation.state !== "active") {
          return { error: aiReservationStateConflict() };
        }
        if (reservation.expiresAt.getTime() <= now.getTime()) {
          await this.expireReservation(transaction, reservation, context.requestId, now);
          return { error: aiReservationExpired() };
        }
        if (request.expectedRevision !== reservation.revision) {
          return { error: revisionConflict() };
        }
        const periodStart = monthStart(reservation.createdAt);
        const teamUsage = await transaction.getOrCreateTeamUsageMonth(
          scope.team.tenantId,
          teamId,
          periodStart,
          now,
          true,
        );
        const projectUsage = await transaction.getOrCreateProjectUsageMonth(
          scope.team.tenantId,
          teamId,
          projectId,
          periodStart,
          now,
          true,
        );
        let next: CloudAiUsageReservationRecord;
        if (kind === "settle") {
          const settlement = request as CloudAiUsageSettlementRequest;
          if (
            settlement.actualInputTokens > reservation.reservedInputTokens ||
            settlement.actualOutputTokens > reservation.reservedOutputTokens
          ) {
            return { error: aiReservationStateConflict() };
          }
          const settledCost = tokenCost(
            settlement.actualInputTokens,
            settlement.actualOutputTokens,
            reservation.inputMicrounitsPerMillionTokens,
            reservation.outputMicrounitsPerMillionTokens,
          );
          if (settledCost > reservation.reservedMicrounits) {
            return { error: aiReservationStateConflict() };
          }
          next = {
            ...reservation,
            state: "settled",
            settledInputTokens: settlement.actualInputTokens,
            settledOutputTokens: settlement.actualOutputTokens,
            settledMicrounits: settledCost,
            revision: nextRevision(reservation.revision),
            updatedAt: now,
            settledAt: now,
          };
          await transaction.updateTeamUsageMonth(settleMonth(teamUsage, reservation, next, now));
          await transaction.updateProjectUsageMonth(
            settleMonth(projectUsage, reservation, next, now),
          );
        } else {
          next = {
            ...reservation,
            state: "cancelled",
            revision: nextRevision(reservation.revision),
            updatedAt: now,
            cancelledAt: now,
          };
          await transaction.updateTeamUsageMonth(releaseReservation(teamUsage, reservation, now));
          await transaction.updateProjectUsageMonth(
            releaseReservation(projectUsage, reservation, now),
          );
        }
        if (!(await transaction.updateReservationCas(next, reservation.revision))) {
          throw revisionConflict();
        }
        await transaction.insertUsageEvent(
          usageEvent(
            next,
            kind === "settle" ? "settled" : "cancelled",
            context.requestId,
            this.uuid(),
            now,
          ),
        );
        const response = await this.reservationResponse(transaction, scope, next, context, now, 0);
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId,
          projectId,
          requestHash,
          resourceId: reservationId,
          resultRevision: next.revision,
          responseSnapshot: response,
          scope,
        });
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  private async requirePrincipal(
    transaction: CloudAiUsageTransaction,
    principal: CloudPrincipal,
    now: Date,
  ): Promise<void> {
    await transaction.setPrincipal(principal.accountId, principal.deviceId);
    if (!(await transaction.assertPrincipalActive(principal, now))) {
      throw sessionExpired();
    }
  }

  private async requireTeamScope(
    transaction: CloudAiUsageTransaction,
    principal: CloudPrincipal,
    teamId: string,
  ): Promise<TeamScope> {
    await transaction.clearTeamScope();
    const actor = await transaction.findActiveMembershipForAccount(principal.accountId, teamId);
    if (actor === null) {
      throw resourceNotFound();
    }
    await transaction.setTeamScope(actor.tenantId, teamId);
    const team = await transaction.findTeam(actor.tenantId, teamId);
    if (team?.state !== "active" || actor.state !== "active") {
      throw resourceNotFound();
    }
    return { actor, team };
  }

  private async requireProjectScope(
    transaction: CloudAiUsageTransaction,
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
  ): Promise<ProjectScope> {
    const scope = await this.requireTeamScope(transaction, principal, teamId);
    const project = await transaction.findProject(scope.team.tenantId, projectId);
    if (project?.state !== "active") {
      throw resourceNotFound();
    }
    if (
      !(await transaction.teamHasActiveProjectAssignment(scope.team.tenantId, teamId, projectId))
    ) {
      throw resourceNotFound();
    }
    const assignment = await transaction.findAssignment(
      scope.team.tenantId,
      teamId,
      projectId,
      scope.actor.membershipId,
    );
    return {
      ...scope,
      assignment: assignment?.state === "active" ? assignment : null,
      project,
    };
  }

  private requireBillingAction(scope: TeamScope, action: "billing.read" | "billing.manage"): void {
    const decision = authorizeTeamAction(toAccessMembership(scope.actor), {
      tenantId: scope.team.tenantId,
      teamId: scope.team.teamId,
      projectId: null,
      resourceType: "billing_metadata",
      action,
      resourceState: "active",
    });
    if (!decision.allowed) {
      throw accessForbidden();
    }
  }

  private authorizeUsageRead(scope: TeamScope | ProjectScope, projectId: string | null): boolean {
    if (
      scope.actor.role === "owner" ||
      scope.actor.role === "admin" ||
      scope.actor.role === "finance_admin"
    ) {
      this.requireBillingAction(scope, "billing.read");
      return true;
    }
    if (
      projectId !== null &&
      (scope.actor.role === "author" || scope.actor.role === "reviewer") &&
      "assignment" in scope &&
      scope.assignment !== null
    ) {
      return false;
    }
    throw accessForbidden();
  }

  private requireConsumption(
    scope: ProjectScope,
    purpose: CloudAiUsageReservationRecord["purpose"],
  ): void {
    if (scope.actor.role === "owner" || scope.actor.role === "admin") {
      return;
    }
    if (scope.actor.role === "author" && scope.assignment !== null) {
      return;
    }
    if (
      scope.actor.role === "reviewer" &&
      scope.assignment !== null &&
      purpose === "read_only_review"
    ) {
      return;
    }
    throw accessForbidden();
  }

  private requireReservationOwnership(
    scope: ProjectScope,
    reservation: Pick<CloudAiUsageReservationRecord, "membershipId">,
  ): void {
    if (scope.actor.role === "owner" || scope.actor.role === "admin") {
      return;
    }
    if (reservation.membershipId !== scope.actor.membershipId) {
      throw accessForbidden();
    }
  }

  private async findIdempotency(
    transaction: CloudAiUsageTransaction,
    options: {
      readonly actorAccountId: string;
      readonly context: CloudMutationContext;
      readonly now: Date;
      readonly operationId: UsageMutationOperation;
      readonly projectId: string | null;
      readonly requestHash: string;
      readonly resourceId: string;
      readonly scope: TeamScope;
    },
  ): Promise<CloudAiUsageIdempotencyRecord | null> {
    const keyHash = usageIdempotencyKeyHash({
      actorAccountId: options.actorAccountId,
      idempotencyKey: options.context.idempotencyKey,
      operationId: options.operationId,
      projectId: options.projectId,
      teamId: options.scope.team.teamId,
      tenantId: options.scope.team.tenantId,
    });
    await transaction.lockIdempotency(keyHash);
    await transaction.purgeExpiredIdempotency(keyHash, options.actorAccountId, options.now);
    const existing = await transaction.findIdempotency(keyHash);
    if (existing === null) {
      return null;
    }
    if (
      existing.actorAccountId !== options.actorAccountId ||
      existing.operationId !== options.operationId ||
      existing.tenantId !== options.scope.team.tenantId ||
      existing.teamId !== options.scope.team.teamId ||
      existing.projectId !== options.projectId ||
      existing.resourceId !== options.resourceId ||
      existing.requestHashSha256 !== options.requestHash ||
      existing.expiresAt.getTime() <= options.now.getTime()
    ) {
      throw idempotencyConflict();
    }
    return existing;
  }

  private insertIdempotency(
    transaction: CloudAiUsageTransaction,
    options: {
      readonly actorAccountId: string;
      readonly context: CloudMutationContext;
      readonly now: Date;
      readonly operationId: UsageMutationOperation;
      readonly projectId: string | null;
      readonly requestHash: string;
      readonly resourceId: string;
      readonly resultRevision: number;
      readonly responseSnapshot:
        CloudAiTeamBudgetResponse | CloudAiProjectBudgetResponse | CloudAiUsageReservationResponse;
      readonly scope: TeamScope;
    },
  ): Promise<void> {
    return transaction.insertIdempotency({
      idempotencyKeyHashSha256: usageIdempotencyKeyHash({
        actorAccountId: options.actorAccountId,
        idempotencyKey: options.context.idempotencyKey,
        operationId: options.operationId,
        projectId: options.projectId,
        teamId: options.scope.team.teamId,
        tenantId: options.scope.team.tenantId,
      }),
      actorAccountId: options.actorAccountId,
      operationId: options.operationId,
      tenantId: options.scope.team.tenantId,
      teamId: options.scope.team.teamId,
      projectId: options.projectId,
      resourceId: options.resourceId,
      requestHashSha256: options.requestHash,
      resultRevision: options.resultRevision,
      responseDigestSha256: hashCanonicalJson(options.responseSnapshot),
      responseSnapshot: options.responseSnapshot,
      createdAt: options.now,
      expiresAt: new Date(options.now.getTime() + this.idempotencyLifetimeMs),
    });
  }

  private async reclaimExpiredLeases(
    transaction: CloudAiUsageTransaction,
    scope: TeamScope,
    now: Date,
    requestId: string,
  ): Promise<number> {
    const expired = await transaction.listExpiredReservations(
      scope.team.tenantId,
      scope.team.teamId,
      now,
      MAXIMUM_EXPIRED_LEASE_BATCH,
    );
    if (expired.length === 0) {
      return 0;
    }
    for (const reservation of expired) {
      const periodStart = monthStart(reservation.createdAt);
      const teamUsage = await transaction.getOrCreateTeamUsageMonth(
        scope.team.tenantId,
        scope.team.teamId,
        periodStart,
        now,
        true,
      );
      const projectUsage = await transaction.getOrCreateProjectUsageMonth(
        reservation.tenantId,
        reservation.teamId,
        reservation.projectId,
        periodStart,
        now,
        true,
      );
      const next: CloudAiUsageReservationRecord = {
        ...reservation,
        state: "expired",
        revision: nextRevision(reservation.revision),
        updatedAt: now,
        expiredAt: now,
      };
      await transaction.updateTeamUsageMonth(releaseReservation(teamUsage, reservation, now));
      await transaction.updateProjectUsageMonth(releaseReservation(projectUsage, reservation, now));
      if (!(await transaction.updateReservationCas(next, reservation.revision))) {
        throw revisionConflict();
      }
      await transaction.insertUsageEvent(
        usageEvent(next, "lease_expired", requestId, this.uuid(), now),
      );
    }
    return expired.length;
  }

  private async expireReservation(
    transaction: CloudAiUsageTransaction,
    reservation: CloudAiUsageReservationRecord,
    requestId: string,
    now: Date,
  ): Promise<void> {
    const periodStart = monthStart(reservation.createdAt);
    const teamUsage = await transaction.getOrCreateTeamUsageMonth(
      reservation.tenantId,
      reservation.teamId,
      periodStart,
      now,
      true,
    );
    const projectUsage = await transaction.getOrCreateProjectUsageMonth(
      reservation.tenantId,
      reservation.teamId,
      reservation.projectId,
      periodStart,
      now,
      true,
    );
    const next: CloudAiUsageReservationRecord = {
      ...reservation,
      state: "expired",
      revision: nextRevision(reservation.revision),
      updatedAt: now,
      expiredAt: now,
    };
    await transaction.updateTeamUsageMonth(releaseReservation(teamUsage, reservation, now));
    await transaction.updateProjectUsageMonth(releaseReservation(projectUsage, reservation, now));
    if (!(await transaction.updateReservationCas(next, reservation.revision))) {
      throw revisionConflict();
    }
    await transaction.insertUsageEvent(
      usageEvent(next, "lease_expired", requestId, this.uuid(), now),
    );
  }

  private async buildSummary(
    transaction: CloudAiUsageTransaction,
    options: {
      readonly context: CloudReadContext;
      readonly expiredCount: number;
      readonly includeTeam: boolean;
      readonly now: Date;
      readonly periodStart: string;
      readonly projectId: string | null;
      readonly scope: TeamScope;
      readonly teamBudget?: CloudAiTeamBudgetRecord | null;
    },
  ): Promise<CloudAiUsageSummaryResponse> {
    const teamBudget =
      options.teamBudget ??
      (await transaction.findTeamBudget(options.scope.team.tenantId, options.scope.team.teamId));
    const teamUsage = await transaction.getOrCreateTeamUsageMonth(
      options.scope.team.tenantId,
      options.scope.team.teamId,
      options.periodStart,
      options.now,
    );
    let projectBucket: CloudAiUsageBucket | null = null;
    let projectBudget: CloudAiProjectBudgetRecord | null = null;
    let activeProjectLeaseCount: number | null = null;
    if (options.projectId !== null) {
      const [budget, usage] = await Promise.all([
        transaction.findProjectBudget(
          options.scope.team.tenantId,
          options.scope.team.teamId,
          options.projectId,
        ),
        transaction.getOrCreateProjectUsageMonth(
          options.scope.team.tenantId,
          options.scope.team.teamId,
          options.projectId,
          options.periodStart,
          options.now,
        ),
      ]);
      projectBudget = budget;
      projectBucket = usageBucket(usage, budget?.monthlyLimitMicrounits ?? null);
      activeProjectLeaseCount =
        teamBudget === null
          ? 0
          : await transaction.countActiveProjectReservations(
              options.scope.team.tenantId,
              options.scope.team.teamId,
              options.projectId,
              options.now,
            );
    }
    const activeLeaseCount =
      teamBudget === null
        ? 0
        : await transaction.countActiveReservations(
            options.scope.team.tenantId,
            options.scope.team.teamId,
            options.now,
          );
    return CloudAiUsageSummaryResponseSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: options.context.requestId,
      tenantId: options.scope.team.tenantId,
      teamId: options.scope.team.teamId,
      periodStart: options.periodStart,
      currency: teamBudget?.currency ?? null,
      priceVersion: teamBudget?.priceVersion ?? null,
      teamBudget: options.includeTeam && teamBudget !== null ? toTeamBudget(teamBudget) : null,
      projectBudget: projectBudget === null ? null : toProjectBudget(projectBudget),
      team: options.includeTeam
        ? usageBucket(teamUsage, teamBudget?.monthlyLimitMicrounits ?? null)
        : null,
      project: projectBucket,
      leaseExpiredCount: options.expiredCount,
      activeLeaseCount,
      maximumConcurrentRuns: teamBudget?.maximumConcurrentRuns ?? null,
      activeProjectLeaseCount,
      projectMaximumConcurrentRuns: projectBudget?.maximumConcurrentRuns ?? null,
      effectiveMaximumConcurrentRuns:
        teamBudget === null
          ? null
          : projectBudget?.maximumConcurrentRuns == null
            ? teamBudget.maximumConcurrentRuns
            : Math.min(teamBudget.maximumConcurrentRuns, projectBudget.maximumConcurrentRuns),
      concurrencyHardCapReached:
        teamBudget !== null &&
        (activeLeaseCount >= teamBudget.maximumConcurrentRuns ||
          (projectBudget?.maximumConcurrentRuns != null &&
            activeProjectLeaseCount !== null &&
            activeProjectLeaseCount >= projectBudget.maximumConcurrentRuns)),
      capabilities: usageCapabilities(options.scope, options.projectId),
      serverTime: options.now.toISOString(),
    });
  }

  private async reservationResponse(
    transaction: CloudAiUsageTransaction,
    scope: ProjectScope,
    reservation: CloudAiUsageReservationRecord,
    context: CloudReadContext,
    now: Date,
    expiredCount: number,
  ): Promise<CloudAiUsageReservationResponse> {
    const includeTeam = scope.actor.role === "owner" || scope.actor.role === "admin";
    const summary = await this.buildSummary(transaction, {
      context,
      expiredCount,
      includeTeam,
      now,
      periodStart: monthStart(reservation.createdAt),
      projectId: reservation.projectId,
      scope,
    });
    const { requestId: _requestId, ...summaryWithoutRequestId } = summary;
    void _requestId;
    return CloudAiUsageReservationResponseSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: context.requestId,
      reservation: toReservation(reservation),
      summary: summaryWithoutRequestId,
    });
  }

  private decodeCursor(cursor: string | null): CloudPageAnchor | null {
    if (cursor === null) {
      return null;
    }
    try {
      return this.pageCursorCodec.decode("ai_usage_events", cursor);
    } catch (error: unknown) {
      if (error instanceof InvalidPageCursorError) {
        throw validationFailed("The AI usage event cursor is invalid.");
      }
      throw error;
    }
  }

  private now(): Date {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("The AI usage clock returned an invalid timestamp.");
    }
    return now;
  }
}

function toAccessMembership(record: CloudTeamMembershipRecord): TeamMembership {
  return {
    accountId: record.accountId,
    membershipId: record.membershipId,
    projectIds: null,
    revision: record.revision,
    role: record.role,
    state: record.state,
    teamId: record.teamId,
    tenantId: record.tenantId,
  };
}

function usageCapabilities(
  scope: TeamScope | ProjectScope,
  projectId: string | null,
): {
  readonly manageTeamBudget: boolean;
  readonly manageProjectBudget: boolean;
  readonly consume: boolean;
} {
  const isProjectMember = projectId !== null && "assignment" in scope && scope.assignment !== null;
  return {
    manageTeamBudget: scope.actor.role === "owner" || scope.actor.role === "admin",
    manageProjectBudget:
      projectId !== null &&
      (scope.actor.role === "owner" ||
        scope.actor.role === "admin" ||
        scope.actor.role === "finance_admin"),
    consume:
      projectId !== null &&
      (scope.actor.role === "owner" ||
        scope.actor.role === "admin" ||
        ((scope.actor.role === "author" || scope.actor.role === "reviewer") && isProjectMember)),
  };
}

function teamBudgetResponse(
  record: CloudAiTeamBudgetRecord,
  requestId: string,
): CloudAiTeamBudgetResponse {
  return CloudAiTeamBudgetResponseSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    budget: toTeamBudget(record),
  });
}

function projectBudgetResponse(
  record: CloudAiProjectBudgetRecord,
  requestId: string,
): CloudAiProjectBudgetResponse {
  return CloudAiProjectBudgetResponseSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    budget: toProjectBudget(record),
  });
}

function replayTeamBudgetResponse(
  record: CloudAiUsageIdempotencyRecord,
  tenantId: string,
  teamId: string,
  requestId: string,
): CloudAiTeamBudgetResponse {
  requireValidIdempotencySnapshotDigest(record);
  const parsed = CloudAiTeamBudgetResponseSchema.safeParse(record.responseSnapshot);
  if (
    record.operationId !== "aiBudgets.updateTeam" ||
    !parsed.success ||
    parsed.data.budget.tenantId !== tenantId ||
    parsed.data.budget.teamId !== teamId ||
    parsed.data.budget.revision !== record.resultRevision
  ) {
    throw new Error("The idempotent AI team-budget response snapshot is invalid.");
  }
  // Replay preserves the original result while using the current request id for traceability.
  return { ...parsed.data, requestId };
}

function replayProjectBudgetResponse(
  record: CloudAiUsageIdempotencyRecord,
  tenantId: string,
  teamId: string,
  projectId: string,
  requestId: string,
): CloudAiProjectBudgetResponse {
  requireValidIdempotencySnapshotDigest(record);
  const parsed = CloudAiProjectBudgetResponseSchema.safeParse(record.responseSnapshot);
  if (
    record.operationId !== "aiBudgets.updateProject" ||
    !parsed.success ||
    parsed.data.budget.tenantId !== tenantId ||
    parsed.data.budget.teamId !== teamId ||
    parsed.data.budget.projectId !== projectId ||
    parsed.data.budget.revision !== record.resultRevision
  ) {
    throw new Error("The idempotent AI project-budget response snapshot is invalid.");
  }
  return { ...parsed.data, requestId };
}

function replayReservationResponse(
  record: CloudAiUsageIdempotencyRecord,
  tenantId: string,
  teamId: string,
  projectId: string,
  reservationId: string,
  expectedState: "active" | "settled" | "cancelled",
  requestId: string,
): CloudAiUsageReservationResponse {
  requireValidIdempotencySnapshotDigest(record);
  const parsed = CloudAiUsageReservationResponseSchema.safeParse(record.responseSnapshot);
  const expectedOperation =
    expectedState === "active"
      ? "aiUsage.reserve"
      : expectedState === "settled"
        ? "aiUsage.settle"
        : "aiUsage.cancel";
  if (
    record.operationId !== expectedOperation ||
    !parsed.success ||
    parsed.data.reservation.tenantId !== tenantId ||
    parsed.data.reservation.teamId !== teamId ||
    parsed.data.reservation.projectId !== projectId ||
    parsed.data.reservation.reservationId !== reservationId ||
    parsed.data.reservation.state !== expectedState ||
    parsed.data.reservation.revision !== record.resultRevision ||
    parsed.data.summary.tenantId !== tenantId ||
    parsed.data.summary.teamId !== teamId ||
    parsed.data.summary.project?.projectId !== projectId ||
    (parsed.data.summary.teamBudget !== null &&
      (parsed.data.summary.teamBudget.tenantId !== tenantId ||
        parsed.data.summary.teamBudget.teamId !== teamId)) ||
    (parsed.data.summary.projectBudget !== null &&
      (parsed.data.summary.projectBudget.tenantId !== tenantId ||
        parsed.data.summary.projectBudget.teamId !== teamId ||
        parsed.data.summary.projectBudget.projectId !== projectId))
  ) {
    throw new Error("The idempotent AI reservation response snapshot is invalid.");
  }
  return { ...parsed.data, requestId };
}

function requireValidIdempotencySnapshotDigest(record: CloudAiUsageIdempotencyRecord): void {
  if (hashCanonicalJson(record.responseSnapshot) !== record.responseDigestSha256) {
    throw new Error("The idempotent AI usage response snapshot digest is invalid.");
  }
}

function toTeamBudget(record: CloudAiTeamBudgetRecord): CloudAiTeamBudget {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tenantId: record.tenantId,
    teamId: record.teamId,
    currency: record.currency,
    monthlyLimitMicrounits: record.monthlyLimitMicrounits,
    warningThresholdBasisPoints: 8_000,
    hardCap: true,
    priceVersion: record.priceVersion,
    inputMicrounitsPerMillionTokens: record.inputMicrounitsPerMillionTokens,
    outputMicrounitsPerMillionTokens: record.outputMicrounitsPerMillionTokens,
    maximumConcurrentRuns: record.maximumConcurrentRuns,
    revision: record.revision,
    updatedByMembershipId: record.updatedByMembershipId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toProjectBudget(record: CloudAiProjectBudgetRecord): CloudAiProjectBudget {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tenantId: record.tenantId,
    teamId: record.teamId,
    projectId: record.projectId,
    monthlyLimitMicrounits: record.monthlyLimitMicrounits,
    maximumConcurrentRuns: record.maximumConcurrentRuns,
    revision: record.revision,
    updatedByMembershipId: record.updatedByMembershipId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toReservation(record: CloudAiUsageReservationRecord): CloudAiUsageReservation {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    reservationId: record.reservationId,
    tenantId: record.tenantId,
    teamId: record.teamId,
    projectId: record.projectId,
    membershipId: record.membershipId,
    modelIdentifier: record.modelIdentifier,
    purpose: record.purpose,
    priceVersion: record.priceVersion,
    currency: record.currency,
    state: record.state,
    reservedInputTokens: record.reservedInputTokens,
    reservedOutputTokens: record.reservedOutputTokens,
    reservedMicrounits: record.reservedMicrounits,
    settledInputTokens: record.settledInputTokens,
    settledOutputTokens: record.settledOutputTokens,
    settledMicrounits: record.settledMicrounits,
    revision: record.revision,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    settledAt: record.settledAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    expiredAt: record.expiredAt?.toISOString() ?? null,
  };
}

function toUsageEvent(record: CloudAiUsageEventRecord): CloudAiUsageEvent {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    eventId: record.eventId,
    tenantId: record.tenantId,
    teamId: record.teamId,
    projectId: record.projectId,
    membershipId: record.membershipId,
    reservationId: record.reservationId,
    requestId: record.requestId,
    eventType: record.eventType,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    costMicrounits: record.costMicrounits,
    currency: record.currency,
    priceVersion: record.priceVersion,
    modelIdentifier: record.modelIdentifier,
    purpose: record.purpose,
    createdAt: record.createdAt.toISOString(),
  };
}

function usageBucket(usage: CloudAiUsageMonthRecord, limit: number | null): CloudAiUsageBucket {
  const used = safeAdd(usage.settledMicrounits, usage.reservedMicrounits);
  const status =
    limit === null
      ? "unconfigured"
      : used >= limit
        ? "hard_cap"
        : BigInt(used) * 10_000n >= BigInt(limit) * 8_000n
          ? "warning"
          : "ok";
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scope: usage.projectId === null ? "team" : "project",
    projectId: usage.projectId,
    monthlyLimitMicrounits: limit,
    settledMicrounits: usage.settledMicrounits,
    reservedMicrounits: usage.reservedMicrounits,
    remainingMicrounits: limit === null ? null : Math.max(0, limit - used),
    settledInputTokens: usage.settledInputTokens,
    settledOutputTokens: usage.settledOutputTokens,
    reservedInputTokens: usage.reservedInputTokens,
    reservedOutputTokens: usage.reservedOutputTokens,
    status,
    updatedAt: usage.updatedAt.toISOString(),
  };
}

function hasUsage(usage: CloudAiUsageMonthRecord): boolean {
  return (
    usage.settledMicrounits > 0 ||
    usage.reservedMicrounits > 0 ||
    usage.settledInputTokens > 0 ||
    usage.settledOutputTokens > 0 ||
    usage.reservedInputTokens > 0 ||
    usage.reservedOutputTokens > 0
  );
}

function monthStart(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${month}-01`;
}

function tokenCost(
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number,
): number {
  const input = ceilDivide(BigInt(inputTokens) * BigInt(inputRate), PRICE_TOKEN_DENOMINATOR);
  const output = ceilDivide(BigInt(outputTokens) * BigInt(outputRate), PRICE_TOKEN_DENOMINATOR);
  const total = input + output;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw validationFailed("The AI usage cost exceeds the portable integer range.");
  }
  return Number(total);
}

function ceilDivide(value: bigint, denominator: bigint): bigint {
  return value === 0n ? 0n : (value + denominator - 1n) / denominator;
}

function wouldExceed(
  settled: number,
  reserved: number,
  additional: number,
  limit: number,
): boolean {
  return BigInt(settled) + BigInt(reserved) + BigInt(additional) > BigInt(limit);
}

function addReservation(
  usage: CloudAiUsageMonthRecord,
  reservation: CloudAiUsageReservationRecord,
  now: Date,
): CloudAiUsageMonthRecord {
  return {
    ...usage,
    reservedMicrounits: safeAdd(usage.reservedMicrounits, reservation.reservedMicrounits),
    reservedInputTokens: safeAdd(usage.reservedInputTokens, reservation.reservedInputTokens),
    reservedOutputTokens: safeAdd(usage.reservedOutputTokens, reservation.reservedOutputTokens),
    updatedAt: now,
  };
}

function releaseReservation(
  usage: CloudAiUsageMonthRecord,
  reservation: CloudAiUsageReservationRecord,
  now: Date,
): CloudAiUsageMonthRecord {
  return {
    ...usage,
    reservedMicrounits: safeSubtract(usage.reservedMicrounits, reservation.reservedMicrounits),
    reservedInputTokens: safeSubtract(usage.reservedInputTokens, reservation.reservedInputTokens),
    reservedOutputTokens: safeSubtract(
      usage.reservedOutputTokens,
      reservation.reservedOutputTokens,
    ),
    updatedAt: now,
  };
}

function settleMonth(
  usage: CloudAiUsageMonthRecord,
  reservation: CloudAiUsageReservationRecord,
  settled: CloudAiUsageReservationRecord,
  now: Date,
): CloudAiUsageMonthRecord {
  const released = releaseReservation(usage, reservation, now);
  return {
    ...released,
    settledMicrounits: safeAdd(released.settledMicrounits, settled.settledMicrounits),
    settledInputTokens: safeAdd(released.settledInputTokens, settled.settledInputTokens),
    settledOutputTokens: safeAdd(released.settledOutputTokens, settled.settledOutputTokens),
  };
}

function usageEvent(
  reservation: CloudAiUsageReservationRecord,
  eventType: CloudAiUsageEventRecord["eventType"],
  requestId: string,
  eventId: string,
  now: Date,
): CloudAiUsageEventRecord {
  const terminal = eventType === "settled";
  return {
    tenantId: reservation.tenantId,
    teamId: reservation.teamId,
    projectId: reservation.projectId,
    eventId,
    membershipId: reservation.membershipId,
    reservationId: reservation.reservationId,
    requestId,
    eventType,
    inputTokens: terminal ? reservation.settledInputTokens : reservation.reservedInputTokens,
    outputTokens: terminal ? reservation.settledOutputTokens : reservation.reservedOutputTokens,
    costMicrounits: terminal ? reservation.settledMicrounits : reservation.reservedMicrounits,
    currency: reservation.currency,
    priceVersion: reservation.priceVersion,
    modelIdentifier: reservation.modelIdentifier,
    purpose: reservation.purpose,
    createdAt: now,
  };
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw validationFailed("An AI usage counter exceeds the portable integer range.");
  }
  return value;
}

function safeSubtract(left: number, right: number): number {
  const value = left - right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("An authoritative AI usage counter would become negative.");
  }
  return value;
}

function nextRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw revisionConflict();
  }
  return value + 1;
}

function requirePageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_PAGE_SIZE) {
    throw validationFailed("AI usage event page size is outside the supported range.");
  }
  return value;
}

function usageIdempotencyKeyHash(options: {
  readonly actorAccountId: string;
  readonly idempotencyKey: string;
  readonly operationId: UsageMutationOperation;
  readonly projectId: string | null;
  readonly teamId: string;
  readonly tenantId: string;
}): string {
  return hashCanonicalJson({
    actorAccountId: options.actorAccountId,
    operationId: options.operationId,
    tenantId: options.tenantId,
    teamId: options.teamId,
    projectId: options.projectId,
    idempotencyKeyHashSha256: hashUtf8(options.idempotencyKey),
  });
}

function unwrap<Output>(outcome: MutationOutcome<Output>): Output {
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
