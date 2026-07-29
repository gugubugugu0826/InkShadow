import { createHash } from "node:crypto";

import {
  authorizeTeamAction,
  type AccessAction,
  type AccessDecision,
  type TeamMembership,
} from "@inkshadow/access-core";
import {
  CloudReviewListResponseSchema,
  CloudReviewResponseSchema,
  CloudReviewSuggestionDecisionResponseSchema,
  CloudReviewThreadItemListResponseSchema,
  CloudReviewThreadItemResponseSchema,
  CloudReviewThreadListResponseSchema,
  CloudReviewThreadResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudApiOperationId,
  type CloudReview,
  type CloudReviewDecisionRequest,
  type CloudReviewListResponse,
  type CloudReviewResponse,
  type CloudReviewSubmissionRequest,
  type CloudReviewSuggestionDecisionRequest,
  type CloudReviewSuggestionDecisionResponse,
  type CloudReviewThread,
  type CloudReviewThreadItem,
  type CloudReviewThreadItemAppendRequest,
  type CloudReviewThreadItemListResponse,
  type CloudReviewThreadItemResponse,
  type CloudReviewThreadListResponse,
  type CloudReviewThreadResolutionRequest,
  type CloudReviewThreadResponse,
  type CloudReviewThreadItemType,
} from "@inkshadow/contracts";

import type { CloudProjectRecord } from "../domain/project-records.js";
import type {
  CloudReviewRecord,
  CloudReviewThreadItemRecord,
  CloudReviewThreadRecord,
} from "../domain/review-records.js";
import type { CloudIdempotencyRecord, CloudPageAnchor } from "../domain/records.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamAuditEventRecord,
  CloudTeamMembershipRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type { CloudReviewStore, CloudReviewTransaction } from "../repository/review-store.js";
import {
  createIdempotencyScopeHash,
  hashCanonicalJson,
  hashUtf8,
} from "../security/canonical-hash.js";
import { InvalidPageCursorError } from "../security/page-cursor.js";
import type { CloudPageCursorCodec } from "../security/page-cursor.js";
import type { UuidV7Factory } from "../security/uuid-v7.js";
import {
  accessForbidden,
  idempotencyConflict,
  invalidCiphertext,
  resourceNotFound,
  revisionConflict,
  sessionExpired,
  validationFailed,
  type CloudServiceError,
} from "./errors.js";
import type { CloudMutationContext, CloudPrincipal, CloudReadContext } from "./identity-service.js";

const DEFAULT_IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_PAGE_SIZE = 100;
const MAXIMUM_CIPHERTEXT_BYTES = 256 * 1024 + 16;

interface ReviewScope {
  readonly actor: CloudTeamMembershipRecord;
  readonly assignment: CloudProjectAssignmentRecord;
  readonly project: CloudProjectRecord;
  readonly team: CloudTeamRecord;
}

type MutationOutcome<Output> = { readonly value: Output } | { readonly error: CloudServiceError };

export interface CloudReviewServiceOptions {
  readonly clock?: () => Date;
  readonly idempotencyLifetimeMs?: number;
  readonly pageCursorCodec: CloudPageCursorCodec;
  readonly store: CloudReviewStore;
  readonly uuid: UuidV7Factory;
}

export class CloudReviewService {
  private readonly clock: () => Date;
  private readonly idempotencyLifetimeMs: number;
  private readonly pageCursorCodec: CloudPageCursorCodec;
  private readonly store: CloudReviewStore;
  private readonly uuid: UuidV7Factory;

  public constructor(options: CloudReviewServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.idempotencyLifetimeMs = options.idempotencyLifetimeMs ?? DEFAULT_IDEMPOTENCY_LIFETIME_MS;
    this.pageCursorCodec = options.pageCursorCodec;
    this.store = options.store;
    this.uuid = options.uuid;
    if (!Number.isSafeInteger(this.idempotencyLifetimeMs) || this.idempotencyLifetimeMs <= 0) {
      throw new Error("The review idempotency lifetime must be a positive integer.");
    }
  }

  public async submitReview(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    request: CloudReviewSubmissionRequest,
    context: CloudMutationContext,
  ): Promise<CloudReviewResponse> {
    if (request.teamId !== teamId || request.projectId !== projectId) {
      throw validationFailed("Review submission scope does not match its route.");
    }
    assertCiphertextEnvelope(request.payload);
    const now = this.now();
    const requestHash = hashCanonicalJson({ projectId, request, teamId });
    const outcome = await this.store.transaction<MutationOutcome<CloudReviewResponse>>(
      async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        const scope = await this.requireScope(transaction, principal, teamId, projectId);
        const decision = authorize(scope, "review.submit");
        if (!decision.allowed) {
          return this.deniedMutation(
            transaction,
            scope,
            context,
            now,
            "review.submitted",
            "review_submission",
            request.reviewId,
            decision,
          );
        }
        const replay = await this.findIdempotency(
          transaction,
          "reviews.submit",
          principal.accountId,
          context,
          requestHash,
          now,
        );
        if (replay !== null) {
          return {
            value: replaySnapshot(CloudReviewResponseSchema, replay, context.requestId),
          };
        }
        const projectKey = await transaction.findProjectKeyVersion(
          scope.team.tenantId,
          projectId,
          request.projectKeyVersion,
        );
        if (
          projectKey?.state !== "active" ||
          scope.project.currentKeyVersion !== request.projectKeyVersion
        ) {
          return { error: revisionConflict() };
        }
        if (
          (await transaction.findReview(
            scope.team.tenantId,
            teamId,
            projectId,
            request.reviewId,
            true,
          )) !== null
        ) {
          return { error: revisionConflict() };
        }
        const record: CloudReviewRecord = {
          createdAt: now,
          decidedAt: null,
          decisionByMembershipId: null,
          payload: request.payload,
          projectId,
          projectKeyVersion: request.projectKeyVersion,
          reviewId: request.reviewId,
          revision: 1,
          sourceCiphertextSha256: request.sourceCiphertextSha256,
          sourceVersionId: request.sourceVersionId,
          sourceVersionRevision: request.sourceVersionRevision,
          state: "pending",
          submittedByMembershipId: scope.actor.membershipId,
          teamId,
          tenantId: scope.team.tenantId,
          updatedAt: now,
        };
        await transaction.insertReview(record);
        const response = reviewResponse(record, context.requestId);
        await transaction.insertAuditEvent(
          this.audit({
            action: "review.submitted",
            context,
            now,
            reason: "allowed",
            redactedDiff: {
              projectKeyVersion: record.projectKeyVersion,
              revision: record.revision,
              sourceVersionId: record.sourceVersionId,
              sourceVersionRevision: record.sourceVersionRevision,
            },
            resourceId: record.reviewId,
            resourceType: "review_submission",
            result: "allowed",
            scope,
          }),
        );
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "reviews.submit",
          requestHash,
          response,
          resultResourceId: record.reviewId,
          responseStatus: 201,
        });
        return { value: response };
      },
    );
    return unwrapMutation(outcome);
  }

  public async listReviews(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudReviewListResponse> {
    const pageSize = requirePageSize(limit);
    const anchor = this.decodeCursor("reviews", cursor);
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      const scope = await this.requireScope(transaction, principal, teamId, projectId);
      requireAllowed(scope, "review.read");
      const records = await transaction.listReviews(
        scope.team.tenantId,
        teamId,
        projectId,
        pageSize + 1,
        anchor,
      );
      const page = records.slice(0, pageSize);
      const lastReview = page.at(-1);
      return CloudReviewListResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        reviews: page.map(toReviewSummary),
        nextCursor:
          records.length > pageSize && lastReview !== undefined
            ? this.pageCursorCodec.encode("reviews", reviewAnchor(lastReview))
            : null,
      });
    });
  }

  public async getReview(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    reviewId: string,
    context: CloudReadContext,
  ): Promise<CloudReviewResponse> {
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      const scope = await this.requireScope(transaction, principal, teamId, projectId);
      requireAllowed(scope, "review.read");
      const record = await transaction.findReview(scope.team.tenantId, teamId, projectId, reviewId);
      if (record === null) {
        throw resourceNotFound();
      }
      return reviewResponse(record, context.requestId);
    });
  }

  public async decideReview(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    reviewId: string,
    request: CloudReviewDecisionRequest,
    context: CloudMutationContext,
  ): Promise<CloudReviewResponse> {
    const now = this.now();
    const operationId: CloudApiOperationId = "reviewDecisions.create";
    const requestHash = hashCanonicalJson({ projectId, request, reviewId, teamId });
    const outcome = await this.store.transaction<MutationOutcome<CloudReviewResponse>>(
      async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        const scope = await this.requireScope(transaction, principal, teamId, projectId);
        const access = authorize(
          scope,
          request.decision === "approved" ? "review.approve" : "review.reject",
        );
        if (!access.allowed) {
          return this.deniedMutation(
            transaction,
            scope,
            context,
            now,
            `review.${request.decision}`,
            "review_submission",
            reviewId,
            access,
          );
        }
        const replay = await this.findIdempotency(
          transaction,
          operationId,
          principal.accountId,
          context,
          requestHash,
          now,
        );
        if (replay !== null) {
          return {
            value: replaySnapshot(CloudReviewResponseSchema, replay, context.requestId),
          };
        }
        const existing = await transaction.findReview(
          scope.team.tenantId,
          teamId,
          projectId,
          reviewId,
          true,
        );
        if (existing === null) {
          return { error: resourceNotFound() };
        }
        if (
          existing.state !== "pending" ||
          existing.revision !== request.expectedRevision ||
          existing.revision >= Number.MAX_SAFE_INTEGER
        ) {
          return { error: revisionConflict() };
        }
        const next: CloudReviewRecord = {
          ...existing,
          decidedAt: now,
          decisionByMembershipId: scope.actor.membershipId,
          revision: existing.revision + 1,
          state: request.decision,
          updatedAt: now,
        };
        if (!(await transaction.updateReviewDecisionCas(next, request.expectedRevision))) {
          return { error: revisionConflict() };
        }
        const response = reviewResponse(next, context.requestId);
        await transaction.insertAuditEvent(
          this.audit({
            action: `review.${request.decision}`,
            context,
            now,
            reason: "allowed",
            redactedDiff: {
              revisionFrom: existing.revision,
              revisionTo: next.revision,
              stateFrom: existing.state,
              stateTo: next.state,
            },
            resourceId: reviewId,
            resourceType: "review_submission",
            result: "allowed",
            scope,
          }),
        );
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId,
          requestHash,
          response,
          responseStatus: 200,
          resultResourceId: reviewId,
        });
        return { value: response };
      },
    );
    return unwrapMutation(outcome);
  }

  public async appendThreadItem(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    reviewId: string,
    request: CloudReviewThreadItemAppendRequest,
    context: CloudMutationContext,
  ): Promise<CloudReviewThreadItemResponse> {
    assertCiphertextEnvelope(request.payload);
    const replyShapeIsValid =
      request.itemType === "reply"
        ? request.parentItemId !== null && request.expectedThreadRevision !== null
        : request.parentItemId === null && request.expectedThreadRevision === null;
    if (!replyShapeIsValid) {
      throw validationFailed("Review-thread item shape is invalid.");
    }
    const now = this.now();
    const requestHash = hashCanonicalJson({ projectId, request, reviewId, teamId });
    const outcome = await this.store.transaction<MutationOutcome<CloudReviewThreadItemResponse>>(
      async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        const scope = await this.requireScope(transaction, principal, teamId, projectId);
        const access = authorize(scope, actionForItem(request.itemType));
        if (!access.allowed) {
          return this.deniedMutation(
            transaction,
            scope,
            context,
            now,
            "review_thread_item.appended",
            "review_thread_item",
            request.itemId,
            access,
          );
        }
        const replay = await this.findIdempotency(
          transaction,
          "reviewThreadItems.append",
          principal.accountId,
          context,
          requestHash,
          now,
        );
        if (replay !== null) {
          return {
            value: replaySnapshot(CloudReviewThreadItemResponseSchema, replay, context.requestId),
          };
        }
        const review = await transaction.findReview(
          scope.team.tenantId,
          teamId,
          projectId,
          reviewId,
        );
        if (review === null) {
          return { error: resourceNotFound() };
        }

        let thread: CloudReviewThreadRecord;
        if (request.itemType === "reply") {
          const existing = await transaction.findThread(
            scope.team.tenantId,
            teamId,
            projectId,
            reviewId,
            request.threadId,
            true,
          );
          if (existing === null) {
            return { error: resourceNotFound() };
          }
          if (
            existing.state !== "open" ||
            existing.revision !== request.expectedThreadRevision ||
            existing.itemCount >= 1_000_000 ||
            existing.revision >= Number.MAX_SAFE_INTEGER
          ) {
            return { error: revisionConflict() };
          }
          const parentItemId = request.parentItemId;
          const expectedThreadRevision = request.expectedThreadRevision;
          if (parentItemId === null) {
            return { error: validationFailed("Review reply scope is invalid.") };
          }
          const parent = await transaction.findThreadItem(
            scope.team.tenantId,
            teamId,
            projectId,
            reviewId,
            request.threadId,
            parentItemId,
          );
          if (parent === null) {
            return { error: resourceNotFound() };
          }
          thread = {
            ...existing,
            itemCount: existing.itemCount + 1,
            revision: existing.revision + 1,
            updatedAt: now,
          };
          if (!(await transaction.updateThreadCas(thread, expectedThreadRevision))) {
            return { error: revisionConflict() };
          }
        } else {
          if (
            (await transaction.findThread(
              scope.team.tenantId,
              teamId,
              projectId,
              reviewId,
              request.threadId,
              true,
            )) !== null
          ) {
            return { error: revisionConflict() };
          }
          thread = {
            createdAt: now,
            createdByMembershipId: scope.actor.membershipId,
            itemCount: 1,
            projectId,
            resolvedAt: null,
            resolvedByMembershipId: null,
            reviewId,
            revision: 1,
            rootItemId: request.itemId,
            state: "open",
            teamId,
            tenantId: scope.team.tenantId,
            threadId: request.threadId,
            updatedAt: now,
          };
          await transaction.insertThread(thread);
        }
        const item: CloudReviewThreadItemRecord = {
          createdAt: now,
          createdByMembershipId: scope.actor.membershipId,
          itemId: request.itemId,
          itemType: request.itemType,
          parentItemId: request.parentItemId,
          payload: request.payload,
          projectId,
          reviewId,
          revision: 1,
          suggestionDecidedAt: null,
          suggestionDecidedByMembershipId: null,
          suggestionDecision: request.itemType === "suggestion" ? "pending" : null,
          teamId,
          tenantId: scope.team.tenantId,
          threadId: request.threadId,
          updatedAt: now,
        };
        await transaction.insertThreadItem(item);
        const response = threadItemResponse(thread, item, context.requestId);
        await transaction.insertAuditEvent(
          this.audit({
            action: "review_thread_item.appended",
            context,
            now,
            reason: "allowed",
            redactedDiff: {
              itemType: item.itemType,
              parentItemId: item.parentItemId,
              threadRevision: thread.revision,
            },
            resourceId: item.itemId,
            resourceType: "review_thread_item",
            result: "allowed",
            scope,
          }),
        );
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "reviewThreadItems.append",
          requestHash,
          response,
          responseStatus: 201,
          resultResourceId: item.itemId,
        });
        return { value: response };
      },
    );
    return unwrapMutation(outcome);
  }

  public async listThreads(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    reviewId: string,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudReviewThreadListResponse> {
    const pageSize = requirePageSize(limit);
    const anchor = this.decodeCursor("review_threads", cursor);
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      const scope = await this.requireScope(transaction, principal, teamId, projectId);
      requireAllowed(scope, "review.read");
      if (
        (await transaction.findReview(scope.team.tenantId, teamId, projectId, reviewId)) === null
      ) {
        throw resourceNotFound();
      }
      const records = await transaction.listThreads(
        scope.team.tenantId,
        teamId,
        projectId,
        reviewId,
        pageSize + 1,
        anchor,
      );
      const page = records.slice(0, pageSize);
      const lastThread = page.at(-1);
      return CloudReviewThreadListResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        threads: page.map(toThread),
        nextCursor:
          records.length > pageSize && lastThread !== undefined
            ? this.pageCursorCodec.encode("review_threads", threadAnchor(lastThread))
            : null,
      });
    });
  }

  public async listThreadItems(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudReviewThreadItemListResponse> {
    const pageSize = requirePageSize(limit);
    const anchor = this.decodeCursor("review_thread_items", cursor);
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      const scope = await this.requireScope(transaction, principal, teamId, projectId);
      requireAllowed(scope, "review.read");
      const review = await transaction.findReview(scope.team.tenantId, teamId, projectId, reviewId);
      const thread = await transaction.findThread(
        scope.team.tenantId,
        teamId,
        projectId,
        reviewId,
        threadId,
      );
      if (review === null || thread === null) {
        throw resourceNotFound();
      }
      const records = await transaction.listThreadItems(
        scope.team.tenantId,
        teamId,
        projectId,
        reviewId,
        threadId,
        pageSize + 1,
        anchor,
      );
      const page = records.slice(0, pageSize);
      const lastItem = page.at(-1);
      return CloudReviewThreadItemListResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        thread: toThread(thread),
        items: page.map(toThreadItem),
        nextCursor:
          records.length > pageSize && lastItem !== undefined
            ? this.pageCursorCodec.encode("review_thread_items", threadItemAnchor(lastItem))
            : null,
      });
    });
  }

  public async resolveThread(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    request: CloudReviewThreadResolutionRequest,
    context: CloudMutationContext,
  ): Promise<CloudReviewThreadResponse> {
    const now = this.now();
    const requestHash = hashCanonicalJson({ projectId, request, reviewId, teamId, threadId });
    const outcome = await this.store.transaction<MutationOutcome<CloudReviewThreadResponse>>(
      async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        const scope = await this.requireScope(transaction, principal, teamId, projectId);
        const access = authorize(scope, "review.resolve");
        if (!access.allowed) {
          return this.deniedMutation(
            transaction,
            scope,
            context,
            now,
            "review_thread.resolved",
            "review_thread",
            threadId,
            access,
          );
        }
        const replay = await this.findIdempotency(
          transaction,
          "reviewThreads.resolve",
          principal.accountId,
          context,
          requestHash,
          now,
        );
        if (replay !== null) {
          return {
            value: replaySnapshot(CloudReviewThreadResponseSchema, replay, context.requestId),
          };
        }
        const review = await transaction.findReview(
          scope.team.tenantId,
          teamId,
          projectId,
          reviewId,
        );
        const existing = await transaction.findThread(
          scope.team.tenantId,
          teamId,
          projectId,
          reviewId,
          threadId,
          true,
        );
        if (review === null || existing === null) {
          return { error: resourceNotFound() };
        }
        if (
          existing.state !== "open" ||
          existing.revision !== request.expectedRevision ||
          existing.revision >= Number.MAX_SAFE_INTEGER
        ) {
          return { error: revisionConflict() };
        }
        const next: CloudReviewThreadRecord = {
          ...existing,
          resolvedAt: now,
          resolvedByMembershipId: scope.actor.membershipId,
          revision: existing.revision + 1,
          state: "resolved",
          updatedAt: now,
        };
        if (!(await transaction.updateThreadCas(next, request.expectedRevision))) {
          return { error: revisionConflict() };
        }
        const response = threadResponse(next, context.requestId);
        await transaction.insertAuditEvent(
          this.audit({
            action: "review_thread.resolved",
            context,
            now,
            reason: "allowed",
            redactedDiff: {
              revisionFrom: existing.revision,
              revisionTo: next.revision,
            },
            resourceId: threadId,
            resourceType: "review_thread",
            result: "allowed",
            scope,
          }),
        );
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "reviewThreads.resolve",
          requestHash,
          response,
          responseStatus: 200,
          resultResourceId: threadId,
        });
        return { value: response };
      },
    );
    return unwrapMutation(outcome);
  }

  public async decideSuggestion(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    itemId: string,
    request: CloudReviewSuggestionDecisionRequest,
    context: CloudMutationContext,
  ): Promise<CloudReviewSuggestionDecisionResponse> {
    const now = this.now();
    const requestHash = hashCanonicalJson({
      itemId,
      projectId,
      request,
      reviewId,
      teamId,
      threadId,
    });
    const outcome = await this.store.transaction<
      MutationOutcome<CloudReviewSuggestionDecisionResponse>
    >(async (transaction) => {
      await this.requirePrincipal(transaction, principal, now);
      const scope = await this.requireScope(transaction, principal, teamId, projectId);
      const access = authorize(scope, "review.decide_suggestion");
      if (!access.allowed) {
        return this.deniedMutation(
          transaction,
          scope,
          context,
          now,
          "review_suggestion.decision_recorded",
          "review_thread_item",
          itemId,
          access,
        );
      }
      const replay = await this.findIdempotency(
        transaction,
        "reviewSuggestionDecisions.create",
        principal.accountId,
        context,
        requestHash,
        now,
      );
      if (replay !== null) {
        return {
          value: replaySnapshot(
            CloudReviewSuggestionDecisionResponseSchema,
            replay,
            context.requestId,
          ),
        };
      }
      const review = await transaction.findReview(scope.team.tenantId, teamId, projectId, reviewId);
      const thread = await transaction.findThread(
        scope.team.tenantId,
        teamId,
        projectId,
        reviewId,
        threadId,
        true,
      );
      const existing = await transaction.findThreadItem(
        scope.team.tenantId,
        teamId,
        projectId,
        reviewId,
        threadId,
        itemId,
        true,
      );
      if (review === null || thread === null || existing === null) {
        return { error: resourceNotFound() };
      }
      if (
        thread.state !== "open" ||
        existing.itemType !== "suggestion" ||
        existing.suggestionDecision !== "pending" ||
        existing.revision !== request.expectedRevision ||
        existing.revision >= Number.MAX_SAFE_INTEGER
      ) {
        return { error: revisionConflict() };
      }
      const next: CloudReviewThreadItemRecord = {
        ...existing,
        revision: existing.revision + 1,
        suggestionDecidedAt: now,
        suggestionDecidedByMembershipId: scope.actor.membershipId,
        suggestionDecision: request.decision,
        updatedAt: now,
      };
      if (!(await transaction.updateSuggestionDecisionCas(next, request.expectedRevision))) {
        return { error: revisionConflict() };
      }
      const response = CloudReviewSuggestionDecisionResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        effect: "metadata_only_no_content_mutation",
        thread: toThread(thread),
        item: toThreadItem(next),
      });
      await transaction.insertAuditEvent(
        this.audit({
          action: "review_suggestion.decision_recorded",
          context,
          now,
          reason: "allowed",
          redactedDiff: {
            decision: next.suggestionDecision,
            revisionFrom: existing.revision,
            revisionTo: next.revision,
          },
          resourceId: itemId,
          resourceType: "review_thread_item",
          result: "allowed",
          scope,
        }),
      );
      await this.insertIdempotency(transaction, {
        actorAccountId: principal.accountId,
        context,
        now,
        operationId: "reviewSuggestionDecisions.create",
        requestHash,
        response,
        responseStatus: 200,
        resultResourceId: itemId,
      });
      return { value: response };
    });
    return unwrapMutation(outcome);
  }

  private async requirePrincipal(
    transaction: CloudReviewTransaction,
    principal: CloudPrincipal,
    now: Date,
  ): Promise<void> {
    await transaction.setPrincipal(principal.accountId, principal.deviceId);
    if (!(await transaction.assertPrincipalActive(principal, now))) {
      throw sessionExpired();
    }
  }

  private async requireScope(
    transaction: CloudReviewTransaction,
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
  ): Promise<ReviewScope> {
    await transaction.clearTeamScope();
    const discovered = await transaction.findActiveMembershipForAccount(
      principal.accountId,
      teamId,
    );
    if (discovered === null) {
      throw resourceNotFound();
    }
    await transaction.setTeamScope(discovered.tenantId, teamId);
    const team = await transaction.findTeam(discovered.tenantId, teamId);
    const actor = await transaction.findMembership(
      discovered.tenantId,
      teamId,
      discovered.membershipId,
    );
    const project = await transaction.findProject(discovered.tenantId, projectId);
    const assignment = await transaction.findAssignment(
      discovered.tenantId,
      teamId,
      projectId,
      discovered.membershipId,
    );
    if (
      team?.state !== "active" ||
      actor?.state !== "active" ||
      project?.state !== "active" ||
      assignment?.state !== "active"
    ) {
      throw resourceNotFound();
    }
    return { actor, assignment, project, team };
  }

  private async findIdempotency(
    transaction: CloudReviewTransaction,
    operationId: CloudApiOperationId,
    actorAccountId: string,
    context: CloudMutationContext,
    requestHash: string,
    now: Date,
  ): Promise<CloudIdempotencyRecord | null> {
    const scopeHashSha256 = createIdempotencyScopeHash({
      actorAccountId,
      idempotencyKey: context.idempotencyKey,
      operationId,
    });
    await transaction.lockIdempotency(scopeHashSha256);
    const existing = await transaction.findIdempotency(scopeHashSha256);
    if (existing === null) {
      return null;
    }
    if (
      existing.actorAccountId !== actorAccountId ||
      existing.operationId !== operationId ||
      existing.requestHashSha256 !== requestHash ||
      existing.expiresAt.getTime() <= now.getTime() ||
      existing.resultKind !== "review"
    ) {
      throw idempotencyConflict();
    }
    return existing;
  }

  private insertIdempotency(
    transaction: CloudReviewTransaction,
    options: {
      readonly actorAccountId: string;
      readonly context: CloudMutationContext;
      readonly now: Date;
      readonly operationId: CloudApiOperationId;
      readonly requestHash: string;
      readonly response: unknown;
      readonly responseStatus: number;
      readonly resultResourceId: string;
    },
  ): Promise<void> {
    return transaction.insertIdempotency({
      actorAccountId: options.actorAccountId,
      createdAt: options.now,
      expiresAt: new Date(options.now.getTime() + this.idempotencyLifetimeMs),
      idempotencyKeyHashSha256: hashUtf8(options.context.idempotencyKey),
      operationId: options.operationId,
      requestHashSha256: options.requestHash,
      responseSnapshot: options.response,
      responseStatus: options.responseStatus,
      resultDigestSha256: hashCanonicalJson(options.response),
      resultKind: "review",
      resultResourceId: options.resultResourceId,
      scopeHashSha256: createIdempotencyScopeHash({
        actorAccountId: options.actorAccountId,
        idempotencyKey: options.context.idempotencyKey,
        operationId: options.operationId,
      }),
    });
  }

  private async deniedMutation<Output>(
    transaction: CloudReviewTransaction,
    scope: ReviewScope,
    context: CloudMutationContext,
    now: Date,
    action: string,
    resourceType: CloudTeamAuditEventRecord["resourceType"],
    resourceId: string,
    decision: Extract<AccessDecision, { readonly allowed: false }>,
  ): Promise<MutationOutcome<Output>> {
    await transaction.insertAuditEvent(
      this.audit({
        action,
        context,
        now,
        reason: decision.reason,
        redactedDiff: {},
        resourceId,
        resourceType,
        result: "denied",
        scope,
      }),
    );
    return { error: accessForbidden() };
  }

  private audit(options: {
    readonly action: string;
    readonly context: CloudReadContext;
    readonly now: Date;
    readonly reason: string;
    readonly redactedDiff: Readonly<Record<string, unknown>>;
    readonly resourceId: string;
    readonly resourceType: CloudTeamAuditEventRecord["resourceType"];
    readonly result: CloudTeamAuditEventRecord["result"];
    readonly scope: ReviewScope;
  }): CloudTeamAuditEventRecord {
    return {
      action: options.action,
      actorAccountId: options.scope.actor.accountId,
      actorMembershipId: options.scope.actor.membershipId,
      createdAt: options.now,
      eventId: this.uuid(),
      reason: options.reason,
      redactedDiff: options.redactedDiff,
      requestId: options.context.requestId,
      resourceId: options.resourceId,
      resourceType: options.resourceType,
      result: options.result,
      teamId: options.scope.team.teamId,
      tenantId: options.scope.team.tenantId,
    };
  }

  private decodeCursor(
    kind: "review_thread_items" | "review_threads" | "reviews",
    cursor: string | null,
  ): CloudPageAnchor | null {
    if (cursor === null) {
      return null;
    }
    try {
      return this.pageCursorCodec.decode(kind, cursor);
    } catch (error: unknown) {
      if (error instanceof InvalidPageCursorError) {
        throw validationFailed("The page cursor is invalid.");
      }
      throw error;
    }
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The review service clock returned an invalid timestamp.");
    }
    return new Date(value);
  }
}

function authorize(scope: ReviewScope, action: AccessAction): AccessDecision {
  return authorizeTeamAction(toAccessMembership(scope.actor, scope.project.projectId), {
    action,
    projectId: scope.project.projectId,
    resourceState: "under_review",
    resourceType: "review",
    teamId: scope.team.teamId,
    tenantId: scope.team.tenantId,
  });
}

function requireAllowed(scope: ReviewScope, action: AccessAction): void {
  if (!authorize(scope, action).allowed) {
    throw accessForbidden();
  }
}

function toAccessMembership(record: CloudTeamMembershipRecord, projectId: string): TeamMembership {
  return {
    accountId: record.accountId,
    membershipId: record.membershipId,
    projectIds: [projectId],
    revision: record.revision,
    role: record.role,
    state: record.state,
    teamId: record.teamId,
    tenantId: record.tenantId,
  };
}

function actionForItem(itemType: CloudReviewThreadItemType): AccessAction {
  switch (itemType) {
    case "comment":
      return "review.comment";
    case "suggestion":
      return "review.suggest";
    case "question":
      return "review.question";
    case "rewrite_request":
      return "review.request_rewrite";
    case "reply":
      return "review.reply";
  }
}

function reviewResponse(record: CloudReviewRecord, requestId: string): CloudReviewResponse {
  return CloudReviewResponseSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    review: toReview(record),
  });
}

function threadResponse(
  record: CloudReviewThreadRecord,
  requestId: string,
): CloudReviewThreadResponse {
  return CloudReviewThreadResponseSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    thread: toThread(record),
  });
}

function threadItemResponse(
  thread: CloudReviewThreadRecord,
  item: CloudReviewThreadItemRecord,
  requestId: string,
): CloudReviewThreadItemResponse {
  return CloudReviewThreadItemResponseSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    thread: toThread(thread),
    item: toThreadItem(item),
  });
}

function toReview(record: CloudReviewRecord): CloudReview {
  return {
    ...toReviewSummary(record),
    payload: record.payload,
  };
}

function toReviewSummary(record: CloudReviewRecord): Omit<CloudReview, "payload"> {
  return {
    createdAt: record.createdAt.toISOString(),
    decidedAt: record.decidedAt?.toISOString() ?? null,
    decisionByMembershipId: record.decisionByMembershipId,
    projectId: record.projectId,
    projectKeyVersion: record.projectKeyVersion,
    reviewId: record.reviewId,
    revision: record.revision,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceCiphertextSha256: record.sourceCiphertextSha256,
    sourceVersionId: record.sourceVersionId,
    sourceVersionRevision: record.sourceVersionRevision,
    state: record.state,
    submittedByMembershipId: record.submittedByMembershipId,
    teamId: record.teamId,
    tenantId: record.tenantId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toThread(record: CloudReviewThreadRecord): CloudReviewThread {
  return {
    createdAt: record.createdAt.toISOString(),
    createdByMembershipId: record.createdByMembershipId,
    itemCount: record.itemCount,
    projectId: record.projectId,
    resolvedAt: record.resolvedAt?.toISOString() ?? null,
    resolvedByMembershipId: record.resolvedByMembershipId,
    reviewId: record.reviewId,
    revision: record.revision,
    rootItemId: record.rootItemId,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    state: record.state,
    teamId: record.teamId,
    tenantId: record.tenantId,
    threadId: record.threadId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toThreadItem(record: CloudReviewThreadItemRecord): CloudReviewThreadItem {
  return {
    createdAt: record.createdAt.toISOString(),
    createdByMembershipId: record.createdByMembershipId,
    itemId: record.itemId,
    itemType: record.itemType,
    parentItemId: record.parentItemId,
    payload: record.payload,
    projectId: record.projectId,
    reviewId: record.reviewId,
    revision: record.revision,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    suggestionDecidedAt: record.suggestionDecidedAt?.toISOString() ?? null,
    suggestionDecidedByMembershipId: record.suggestionDecidedByMembershipId,
    suggestionDecision: record.suggestionDecision,
    teamId: record.teamId,
    tenantId: record.tenantId,
    threadId: record.threadId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function assertCiphertextEnvelope(envelope: CloudReviewSubmissionRequest["payload"]): void {
  const nonce = decodeCanonicalBase64Url(envelope.nonce);
  const ciphertext = decodeCanonicalBase64Url(envelope.ciphertext);
  try {
    if (
      nonce.length !== 12 ||
      ciphertext.length < 16 ||
      ciphertext.length > MAXIMUM_CIPHERTEXT_BYTES ||
      createHash("sha256").update(ciphertext).digest("hex") !== envelope.ciphertextSha256
    ) {
      throw invalidCiphertext();
    }
  } finally {
    nonce.fill(0);
    ciphertext.fill(0);
  }
}

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw invalidCiphertext();
  }
  return decoded;
}

function replaySnapshot<Output>(
  schema: { readonly parse: (value: unknown) => Output },
  record: CloudIdempotencyRecord,
  requestId: string,
): Output {
  if (
    record.resultKind !== "review" ||
    typeof record.responseSnapshot !== "object" ||
    record.responseSnapshot === null ||
    hashCanonicalJson(record.responseSnapshot) !== record.resultDigestSha256
  ) {
    throw new Error("The review idempotency record is internally inconsistent.");
  }
  return schema.parse({ ...record.responseSnapshot, requestId });
}

function requirePageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_PAGE_SIZE) {
    throw validationFailed("The requested review page size is invalid.");
  }
  return value;
}

function reviewAnchor(record: CloudReviewRecord): CloudPageAnchor {
  return { createdAt: record.createdAt, id: record.reviewId };
}

function threadAnchor(record: CloudReviewThreadRecord): CloudPageAnchor {
  return { createdAt: record.createdAt, id: record.threadId };
}

function threadItemAnchor(record: CloudReviewThreadItemRecord): CloudPageAnchor {
  return { createdAt: record.createdAt, id: record.itemId };
}

function unwrapMutation<Output>(outcome: MutationOutcome<Output>): Output {
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
