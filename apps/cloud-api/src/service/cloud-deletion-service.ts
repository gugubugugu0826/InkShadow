import {
  CloudDeletionRequestResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudAccountDeletionCancellationRequest,
  type CloudAccountDeletionLookupRequest,
  type CloudAccountDeletionSubmissionRequest,
  type CloudDeletionCancellationRequest,
  type CloudDeletionRequestResponse,
  type CloudDeletionSubmissionRequest,
} from "@inkshadow/contracts";

import {
  toCloudDeletionRequest,
  type CloudDeletionJobProjectRecord,
  type CloudDeletionJobRecord,
} from "../domain/deletion-records.js";
import type { CloudProjectRecord } from "../domain/project-records.js";
import type { CloudAuditEventRecord, CloudIdempotencyRecord } from "../domain/records.js";
import type { CloudDeletionStore, CloudDeletionTransaction } from "../repository/deletion-store.js";
import {
  createIdempotencyScopeHash,
  hashCanonicalJson,
  hashUtf8,
} from "../security/canonical-hash.js";
import type { PasswordHasher } from "../security/passwords.js";
import type { UuidV7Factory } from "../security/uuid-v7.js";
import type { CloudDeletionService } from "./deletion-service.js";
import type { CloudMutationContext, CloudPrincipal, CloudReadContext } from "./identity-service.js";
import {
  accessForbidden,
  accountFrozen,
  idempotencyConflict,
  invalidCredentials,
  resourceNotFound,
  revisionConflict,
} from "./errors.js";

export interface CloudDeletionDomainServiceOptions {
  readonly backupRetentionMs?: number;
  readonly clock?: () => Date;
  readonly gracePeriodMs?: number;
  readonly idempotencyLifetimeMs?: number;
  readonly maximumOwnedProjects?: number;
  readonly pageSize?: number;
  readonly passwordHasher: PasswordHasher;
  readonly store: CloudDeletionStore;
  readonly uuid: UuidV7Factory;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_GRACE_PERIOD_MS = 30 * DAY_MS;
const DEFAULT_BACKUP_RETENTION_MS = 30 * DAY_MS;
const DEFAULT_IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_OWNED_PROJECTS = 1_000;
const DEFAULT_PAGE_SIZE = 250;

type ServiceOutcome<Value> = { readonly error: Error } | { readonly value: Value };

/**
 * Transactional permanent-deletion service.
 *
 * Passwords exist only in the caller's request and the password-verification
 * call. Idempotency records persist a credential-free response snapshot and a
 * deletion-job ID; request credentials are never persisted.
 */
export class CloudDeletionDomainService implements CloudDeletionService {
  private readonly backupRetentionMs: number;
  private readonly clock: () => Date;
  private readonly dummyPasswordHash: Promise<string>;
  private readonly gracePeriodMs: number;
  private readonly idempotencyLifetimeMs: number;
  private readonly maximumOwnedProjects: number;
  private readonly pageSize: number;
  private readonly passwordHasher: PasswordHasher;
  private readonly store: CloudDeletionStore;
  private readonly uuid: UuidV7Factory;

  public constructor(options: CloudDeletionDomainServiceOptions) {
    this.backupRetentionMs = options.backupRetentionMs ?? DEFAULT_BACKUP_RETENTION_MS;
    this.clock = options.clock ?? (() => new Date());
    this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    this.idempotencyLifetimeMs = options.idempotencyLifetimeMs ?? DEFAULT_IDEMPOTENCY_LIFETIME_MS;
    this.maximumOwnedProjects = options.maximumOwnedProjects ?? DEFAULT_MAXIMUM_OWNED_PROJECTS;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.passwordHasher = options.passwordHasher;
    this.store = options.store;
    this.uuid = options.uuid;
    validateOptions({
      backupRetentionMs: this.backupRetentionMs,
      gracePeriodMs: this.gracePeriodMs,
      idempotencyLifetimeMs: this.idempotencyLifetimeMs,
      maximumOwnedProjects: this.maximumOwnedProjects,
      pageSize: this.pageSize,
    });
    this.dummyPasswordHash = this.passwordHasher.hash(
      "inkshadow-deletion-dummy-credential-boundary",
    );
  }

  public async requestProjectDeletion(
    principal: CloudPrincipal,
    projectId: string,
    request: CloudDeletionSubmissionRequest,
    context: CloudMutationContext,
  ): Promise<CloudDeletionRequestResponse> {
    const tenantId = personalTenantId(principal);
    const now = this.now();
    const requestHash = hashProjectDeletionSubmission(projectId, request);
    const outcome = await this.store.transaction<ServiceOutcome<CloudDeletionRequestResponse>>(
      async (transaction) => {
        await transaction.setTenant(tenantId);
        const existing = await this.findIdempotency(
          transaction,
          "projectDeletions.request",
          principal.accountId,
          context.idempotencyKey,
          requestHash,
          now,
        );
        if (existing !== null) {
          return {
            value: this.replayDeletion(existing, context.requestId, "project", projectId, tenantId),
          };
        }

        const account = await transaction.findAccountById(principal.accountId, true);
        const passwordMatches = await this.verifyPassword(request.password, account?.passwordHash);
        if (account === null || !passwordMatches) {
          return { error: invalidCredentials() };
        }
        if (account.state !== "active") {
          return { error: accountFrozen() };
        }

        const project = await transaction.findProject(tenantId, projectId, true);
        if (project === null || project.state === "deleted") {
          return { error: resourceNotFound("The cloud project was not found.") };
        }
        if (project.ownerAccountId !== principal.accountId) {
          return {
            error: accessForbidden("Only the cloud project owner may schedule permanent deletion."),
          };
        }
        if (project.state !== "active") {
          return { error: revisionConflict() };
        }
        if (project.revision !== request.expectedRevision) {
          return { error: revisionConflict() };
        }
        if (
          (await transaction.findActiveDeletionJob(tenantId, "project", projectId, true)) !== null
        ) {
          return { error: revisionConflict() };
        }

        const impact = await transaction.calculateProjectImpact(tenantId, projectId);
        const blocker = await transaction.findActiveRetentionHoldReason(
          tenantId,
          "project",
          projectId,
        );
        const job = this.newDeletionJob({
          blocker,
          confirmationId: request.confirmationId,
          impact,
          now,
          requestedByAccountId: principal.accountId,
          targetId: projectId,
          targetKind: "project",
          tenantId,
        });
        await transaction.insertDeletionJob(job);
        if (
          !(await transaction.freezeProject(
            tenantId,
            projectId,
            request.expectedRevision,
            job.scheduledFor,
            now,
          ))
        ) {
          throw revisionConflict();
        }

        const response = deletionResponse(job, context.requestId, now);
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "projectDeletions.request",
          requestHash,
          response,
          resultResourceId: job.deletionRequestId,
          tenantId,
        });
        await transaction.insertAuditEvent(
          this.auditEvent({
            action: "project.deletion_requested",
            context,
            now,
            principal,
            redactedDiff: {
              scheduledFor: job.scheduledFor.toISOString(),
              affectedEncryptedChunks: impact.encryptedChunkCount,
              affectedKeyEnvelopes: impact.keyEnvelopeCount,
            },
            resourceId: projectId,
            resourceType: "cloud_project",
            tenantId,
          }),
        );
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async getProjectDeletionRequest(
    principal: CloudPrincipal,
    projectId: string,
    context: CloudReadContext,
  ): Promise<CloudDeletionRequestResponse> {
    const tenantId = personalTenantId(principal);
    const now = this.now();
    const outcome = await this.store.transaction<ServiceOutcome<CloudDeletionRequestResponse>>(
      async (transaction) => {
        await transaction.setTenant(tenantId);
        const project = await transaction.findProject(tenantId, projectId, false);
        if (project?.ownerAccountId !== principal.accountId) {
          return { error: resourceNotFound("The cloud deletion request was not found.") };
        }
        const job = await transaction.findLatestDeletionJobForTarget(
          tenantId,
          "project",
          projectId,
          false,
        );
        if (job === null) {
          return { error: resourceNotFound("The cloud deletion request was not found.") };
        }
        return { value: deletionResponse(job, context.requestId, now) };
      },
    );
    return unwrap(outcome);
  }

  public async cancelProjectDeletion(
    principal: CloudPrincipal,
    projectId: string,
    request: CloudDeletionCancellationRequest,
    context: CloudMutationContext,
  ): Promise<CloudDeletionRequestResponse> {
    const tenantId = personalTenantId(principal);
    const now = this.now();
    const requestHash = hashProjectDeletionCancellation(projectId, request);
    const outcome = await this.store.transaction<ServiceOutcome<CloudDeletionRequestResponse>>(
      async (transaction) => {
        await transaction.setTenant(tenantId);
        const existing = await this.findIdempotency(
          transaction,
          "projectDeletions.cancel",
          principal.accountId,
          context.idempotencyKey,
          requestHash,
          now,
        );
        if (existing !== null) {
          return {
            value: this.replayDeletion(existing, context.requestId, "project", projectId, tenantId),
          };
        }

        const job = await transaction.findDeletionJob(tenantId, request.deletionRequestId, true);
        if (job?.targetKind !== "project" || job.targetId !== projectId) {
          return { error: resourceNotFound("The cloud deletion request was not found.") };
        }
        const project = await transaction.findProject(tenantId, projectId, true);
        if (
          project?.ownerAccountId !== principal.accountId ||
          project.state !== "deletion_scheduled"
        ) {
          return { error: resourceNotFound("The cloud deletion request was not found.") };
        }
        const cancellation = await transaction.cancelDeletionJob(
          tenantId,
          job.deletionRequestId,
          request.expectedDeletionRevision,
          now,
        );
        if (cancellation.kind !== "cancelled") {
          return {
            error:
              cancellation.kind === "not_found"
                ? resourceNotFound("The cloud deletion request was not found.")
                : revisionConflict(),
          };
        }

        const response = deletionResponse(cancellation.job, context.requestId, now);
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "projectDeletions.cancel",
          requestHash,
          response,
          resultResourceId: cancellation.job.deletionRequestId,
          tenantId,
        });
        await transaction.insertAuditEvent(
          this.auditEvent({
            action: "project.deletion_cancelled",
            context,
            now,
            principal,
            resourceId: projectId,
            resourceType: "cloud_project",
            tenantId,
          }),
        );
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async requestAccountDeletion(
    principal: CloudPrincipal,
    request: CloudAccountDeletionSubmissionRequest,
    context: CloudMutationContext,
  ): Promise<CloudDeletionRequestResponse> {
    const tenantId = personalTenantId(principal);
    const now = this.now();
    const requestHash = hashAccountDeletionSubmission(principal.accountId, request);
    const outcome = await this.store.transaction<ServiceOutcome<CloudDeletionRequestResponse>>(
      async (transaction) => {
        await transaction.setTenant(tenantId);
        const existing = await this.findIdempotency(
          transaction,
          "accountDeletions.request",
          principal.accountId,
          context.idempotencyKey,
          requestHash,
          now,
        );
        if (existing !== null) {
          return {
            value: this.replayDeletion(
              existing,
              context.requestId,
              "account",
              principal.accountId,
              tenantId,
            ),
          };
        }

        const account = await transaction.findAccountById(principal.accountId, true);
        const passwordMatches = await this.verifyPassword(request.password, account?.passwordHash);
        if (account === null || !passwordMatches || account.emailCanonical !== request.email) {
          return { error: invalidCredentials() };
        }
        if (account.state !== "active") {
          return { error: accountFrozen() };
        }
        if (account.revision !== request.expectedRevision) {
          return { error: revisionConflict() };
        }
        if (await transaction.accountRequiresOwnershipTransfer(account.accountId)) {
          await transaction.insertAuditEvent(
            this.auditEvent({
              action: "account.deletion_denied",
              context,
              now,
              principal,
              redactedDiff: {
                reason: "ownership_transfer_required",
              },
              resourceId: account.accountId,
              resourceType: "cloud_account",
              result: "denied",
              tenantId,
            }),
          );
          return {
            error: accessForbidden(
              "Resolve team ownership and collaborative project access assignments before scheduling account deletion.",
            ),
          };
        }

        const childJobs = await this.listBoundedActiveProjectJobs(
          transaction,
          tenantId,
          account.accountId,
        );
        for (const childJob of childJobs) {
          const cancellation = await transaction.cancelDeletionJob(
            tenantId,
            childJob.deletionRequestId,
            childJob.revision,
            now,
          );
          if (cancellation.kind !== "cancelled") {
            throw revisionConflict();
          }
        }

        const projects = await this.listBoundedOwnedProjects(
          transaction,
          tenantId,
          account.accountId,
        );
        if (
          projects.some(
            (project) =>
              project.tenantId !== tenantId ||
              project.ownerAccountId !== account.accountId ||
              project.state !== "active",
          )
        ) {
          throw accessForbidden(
            "Account deletion requires every owned cloud project to be transferable.",
          );
        }
        if (
          (await transaction.findActiveDeletionJob(
            tenantId,
            "account",
            account.accountId,
            true,
          )) !== null
        ) {
          throw revisionConflict();
        }

        const impact = await transaction.calculateAccountImpact(tenantId, account.accountId);
        if (impact.projectCount !== projects.length) {
          throw new Error("Account deletion impact did not match the frozen project set.");
        }
        const blocker = await transaction.findActiveRetentionHoldReason(
          tenantId,
          "account",
          account.accountId,
        );
        const job = this.newDeletionJob({
          blocker,
          confirmationId: request.confirmationId,
          impact,
          now,
          requestedByAccountId: account.accountId,
          targetId: account.accountId,
          targetKind: "account",
          tenantId,
        });
        await transaction.insertDeletionJob(job);

        let ordinal = 0;
        for (const project of projects) {
          ordinal += 1;
          const frozenProject: CloudDeletionJobProjectRecord = {
            completedAt: null,
            deletionRequestId: job.deletionRequestId,
            ordinal,
            originalDeletionScheduledFor: project.deletionScheduledFor,
            originalState: "active",
            phase: "derived",
            projectId: project.projectId,
            projectRevisionAtFreeze: project.revision,
            tenantId,
            updatedAt: now,
          };
          await transaction.insertDeletionJobProject(frozenProject);
          if (
            !(await transaction.freezeProject(
              tenantId,
              project.projectId,
              project.revision,
              job.scheduledFor,
              now,
            ))
          ) {
            throw revisionConflict();
          }
        }
        if (
          !(await transaction.freezeAccount(
            account.accountId,
            account.revision,
            job.scheduledFor,
            now,
          ))
        ) {
          throw revisionConflict();
        }
        const revokedSessionCount = await transaction.revokeSessionsForAccount(
          account.accountId,
          now,
        );

        const response = deletionResponse(job, context.requestId, now);
        await this.insertIdempotency(transaction, {
          actorAccountId: account.accountId,
          context,
          now,
          operationId: "accountDeletions.request",
          requestHash,
          response,
          resultResourceId: job.deletionRequestId,
          tenantId,
        });
        await transaction.insertAuditEvent(
          this.auditEvent({
            action: "account.deletion_requested",
            context,
            now,
            principal,
            redactedDiff: {
              scheduledFor: job.scheduledFor.toISOString(),
              affectedProjects: projects.length,
              revokedSessions: revokedSessionCount,
            },
            resourceId: account.accountId,
            resourceType: "cloud_account",
            tenantId,
          }),
        );
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async lookupAccountDeletion(
    request: CloudAccountDeletionLookupRequest,
    context: CloudReadContext,
  ): Promise<CloudDeletionRequestResponse> {
    const now = this.now();
    const outcome = await this.store.transaction<ServiceOutcome<CloudDeletionRequestResponse>>(
      async (transaction) => {
        const account = await transaction.findAccountByEmail(request.email, true);
        const passwordMatches = await this.verifyPassword(request.password, account?.passwordHash);
        if (account === null || !passwordMatches) {
          return { error: invalidCredentials() };
        }
        const tenantId = account.accountId;
        await transaction.setTenant(tenantId);
        const job =
          "deletionRequestId" in request
            ? await transaction.findDeletionJob(tenantId, request.deletionRequestId, false)
            : await transaction.findDeletionJobByConfirmation(
                tenantId,
                "account",
                account.accountId,
                request.confirmationId,
                false,
              );
        if (job?.targetKind !== "account" || job.targetId !== account.accountId) {
          return { error: invalidCredentials() };
        }
        await transaction.insertAuditEvent(
          this.auditEvent({
            action: "account.deletion_lookup",
            context,
            now,
            principal: null,
            resourceId: job.deletionRequestId,
            resourceType: "cloud_deletion_job",
            tenantId,
            actorAccountId: account.accountId,
          }),
        );
        return { value: deletionResponse(job, context.requestId, now) };
      },
    );
    return unwrap(outcome);
  }

  public async cancelAccountDeletion(
    request: CloudAccountDeletionCancellationRequest,
    context: CloudMutationContext,
  ): Promise<CloudDeletionRequestResponse> {
    const now = this.now();
    const requestHash = hashAccountDeletionCancellation(request);
    const outcome = await this.store.transaction<ServiceOutcome<CloudDeletionRequestResponse>>(
      async (transaction) => {
        const account = await transaction.findAccountByEmail(request.email, false);
        const passwordMatches = await this.verifyPassword(request.password, account?.passwordHash);
        if (account === null || !passwordMatches) {
          return { error: invalidCredentials() };
        }
        const tenantId = account.accountId;
        await transaction.setTenant(tenantId);
        const existing = await this.findIdempotency(
          transaction,
          "accountDeletions.cancel",
          account.accountId,
          context.idempotencyKey,
          requestHash,
          now,
        );
        if (existing !== null) {
          return {
            value: this.replayDeletion(
              existing,
              context.requestId,
              "account",
              account.accountId,
              tenantId,
            ),
          };
        }

        const job = await transaction.findDeletionJob(tenantId, request.deletionRequestId, true);
        if (job?.targetKind !== "account" || job.targetId !== account.accountId) {
          return { error: invalidCredentials() };
        }
        const lockedAccount = await transaction.findAccountById(account.accountId, true);
        if (
          lockedAccount?.emailCanonical !== account.emailCanonical ||
          lockedAccount.passwordHash !== account.passwordHash
        ) {
          return { error: invalidCredentials() };
        }
        const cancellation = await transaction.cancelDeletionJob(
          tenantId,
          job.deletionRequestId,
          request.expectedDeletionRevision,
          now,
        );
        if (cancellation.kind !== "cancelled") {
          return {
            error: cancellation.kind === "not_found" ? invalidCredentials() : revisionConflict(),
          };
        }
        const response = deletionResponse(cancellation.job, context.requestId, now);
        await this.insertIdempotency(transaction, {
          actorAccountId: account.accountId,
          context,
          now,
          operationId: "accountDeletions.cancel",
          requestHash,
          response,
          resultResourceId: cancellation.job.deletionRequestId,
          tenantId,
        });
        await transaction.insertAuditEvent(
          this.auditEvent({
            action: "account.deletion_cancelled",
            context,
            now,
            principal: null,
            resourceId: account.accountId,
            resourceType: "cloud_account",
            tenantId,
            actorAccountId: account.accountId,
          }),
        );
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  private newDeletionJob(options: {
    readonly blocker: CloudDeletionJobRecord["blockedReason"];
    readonly confirmationId: string;
    readonly impact: CloudDeletionJobRecord["impact"];
    readonly now: Date;
    readonly requestedByAccountId: string;
    readonly targetId: string;
    readonly targetKind: CloudDeletionJobRecord["targetKind"];
    readonly tenantId: string;
  }): CloudDeletionJobRecord {
    const scheduledFor = addMilliseconds(options.now, this.gracePeriodMs);
    return {
      attemptCount: 0,
      backupRetainedUntil: null,
      backupRetentionSeconds: this.backupRetentionMs / 1_000,
      blockedReason: options.blocker,
      cancellableUntil: scheduledFor,
      commitStartedAt: null,
      completedAt: null,
      confirmationId: options.confirmationId,
      createdAt: options.now,
      deletionRequestId: this.uuid(),
      impact: options.impact,
      lastFailureCode: null,
      leaseExpiresAt: null,
      leaseOwner: null,
      liveDataPurgedAt: null,
      nextAttemptAt: scheduledFor,
      phase: "freeze",
      requestedAt: options.now,
      requestedByAccountId: options.requestedByAccountId,
      revision: 1,
      scheduledFor,
      state: options.blocker === null ? "grace_period" : "blocked",
      targetId: options.targetId,
      targetKind: options.targetKind,
      tenantId: options.tenantId,
      updatedAt: options.now,
    };
  }

  private async listBoundedActiveProjectJobs(
    transaction: CloudDeletionTransaction,
    tenantId: string,
    accountId: string,
  ): Promise<readonly CloudDeletionJobRecord[]> {
    const jobs: CloudDeletionJobRecord[] = [];
    let cursor: string | null = null;
    while (jobs.length <= this.maximumOwnedProjects) {
      const remaining = this.maximumOwnedProjects + 1 - jobs.length;
      const page = await transaction.listActiveProjectDeletionJobsForOwner(
        tenantId,
        accountId,
        cursor,
        Math.min(this.pageSize, remaining),
        true,
      );
      if (page.length === 0) {
        return jobs;
      }
      for (const job of page) {
        if (job.targetKind !== "project" || job.tenantId !== tenantId || job.targetId === cursor) {
          throw new Error("Account deletion loaded an invalid child deletion job.");
        }
        jobs.push(job);
        cursor = job.targetId;
      }
      if (page.length < Math.min(this.pageSize, remaining)) {
        return jobs;
      }
    }
    throw accessForbidden("Account deletion exceeds the supported owned-project bound.");
  }

  private async listBoundedOwnedProjects(
    transaction: CloudDeletionTransaction,
    tenantId: string,
    accountId: string,
  ): Promise<readonly CloudProjectRecord[]> {
    const projects: CloudProjectRecord[] = [];
    let cursor: string | null = null;
    while (projects.length <= this.maximumOwnedProjects) {
      const remaining = this.maximumOwnedProjects + 1 - projects.length;
      const requestedLimit = Math.min(this.pageSize, remaining);
      const page = await transaction.listOwnedProjects(
        tenantId,
        accountId,
        cursor,
        requestedLimit,
        true,
      );
      if (page.length === 0) {
        return projects;
      }
      for (const project of page) {
        if (project.projectId === cursor) {
          throw new Error("Account deletion project pagination did not advance.");
        }
        projects.push(project);
        cursor = project.projectId;
      }
      if (page.length < requestedLimit) {
        return projects;
      }
    }
    throw accessForbidden("Account deletion exceeds the supported owned-project bound.");
  }

  private async verifyPassword(
    password: string,
    passwordHash: string | undefined,
  ): Promise<boolean> {
    return this.passwordHasher.verify(password, passwordHash ?? (await this.dummyPasswordHash));
  }

  private async findIdempotency(
    transaction: CloudDeletionTransaction,
    operationId: CloudIdempotencyRecord["operationId"],
    actorAccountId: string,
    idempotencyKey: string,
    requestHash: string,
    now: Date,
  ): Promise<CloudIdempotencyRecord | null> {
    const scopeHash = createIdempotencyScopeHash({
      actorAccountId,
      idempotencyKey,
      operationId,
    });
    await transaction.lockIdempotency(scopeHash);
    const existing = await transaction.findIdempotency(scopeHash);
    if (existing === null) {
      return null;
    }
    if (
      existing.operationId !== operationId ||
      existing.requestHashSha256 !== requestHash ||
      existing.expiresAt.getTime() <= now.getTime()
    ) {
      throw idempotencyConflict();
    }
    return existing;
  }

  private async insertIdempotency(
    transaction: CloudDeletionTransaction,
    options: {
      readonly actorAccountId: string;
      readonly context: CloudMutationContext;
      readonly now: Date;
      readonly operationId: CloudIdempotencyRecord["operationId"];
      readonly requestHash: string;
      readonly response: CloudDeletionRequestResponse;
      readonly resultResourceId: string;
      readonly tenantId: string;
    },
  ): Promise<void> {
    await transaction.insertIdempotency({
      actorAccountId: options.actorAccountId,
      createdAt: options.now,
      expiresAt: addMilliseconds(options.now, this.idempotencyLifetimeMs),
      idempotencyKeyHashSha256: hashUtf8(options.context.idempotencyKey),
      operationId: options.operationId,
      requestHashSha256: options.requestHash,
      responseSnapshot: {
        response: options.response,
        snapshotKind: "deletion_job_v1",
        tenantId: options.tenantId,
      },
      responseStatus: options.operationId.endsWith(".request") ? 202 : 200,
      resultDigestSha256: hashCanonicalJson(options.response),
      resultKind: "deletion_job",
      resultResourceId: options.resultResourceId,
      scopeHashSha256: createIdempotencyScopeHash({
        actorAccountId: options.actorAccountId,
        idempotencyKey: options.context.idempotencyKey,
        operationId: options.operationId,
      }),
    });
  }

  private replayDeletion(
    idempotency: CloudIdempotencyRecord,
    requestId: string,
    targetKind: CloudDeletionJobRecord["targetKind"],
    targetId: string,
    tenantId: string,
  ): CloudDeletionRequestResponse {
    if (idempotency.resultKind !== "deletion_job" || idempotency.resultResourceId === null) {
      throw new Error("The idempotency record does not reference a deletion job.");
    }
    const snapshot = requireDeletionResponseSnapshot(idempotency.responseSnapshot);
    const parsed = CloudDeletionRequestResponseSchema.safeParse(snapshot.response);
    if (
      !parsed.success ||
      hashCanonicalJson(parsed.data) !== idempotency.resultDigestSha256 ||
      snapshot.tenantId !== tenantId ||
      parsed.data.deletionRequest.deletionRequestId !== idempotency.resultResourceId ||
      parsed.data.deletionRequest.targetKind !== targetKind ||
      parsed.data.deletionRequest.targetId !== targetId
    ) {
      throw new Error("The idempotent deletion response snapshot is invalid.");
    }
    return { ...parsed.data, requestId };
  }

  private auditEvent(options: {
    readonly action: string;
    readonly actorAccountId?: string;
    readonly context: CloudReadContext;
    readonly now: Date;
    readonly principal: CloudPrincipal | null;
    readonly redactedDiff?: Readonly<Record<string, unknown>>;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly result?: CloudAuditEventRecord["result"];
    readonly tenantId: string;
  }): CloudAuditEventRecord {
    return {
      action: options.action,
      actorAccountId: options.actorAccountId ?? options.principal?.accountId ?? null,
      actorDeviceId: options.principal?.deviceId ?? null,
      createdAt: options.now,
      eventId: this.uuid(),
      redactedDiff: options.redactedDiff ?? {},
      requestId: options.context.requestId,
      resourceId: options.resourceId,
      resourceType: options.resourceType,
      result: options.result ?? "allowed",
      tenantId: options.tenantId,
    };
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The cloud deletion clock returned an invalid timestamp.");
    }
    return new Date(value);
  }
}

function deletionResponse(
  job: CloudDeletionJobRecord,
  requestId: string,
  now: Date,
): CloudDeletionRequestResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    deletionRequest: toCloudDeletionRequest(job, now),
  };
}

interface StoredDeletionResponseSnapshot {
  readonly response: unknown;
  readonly snapshotKind: "deletion_job_v1";
  readonly tenantId: string;
}

function requireDeletionResponseSnapshot(value: unknown): StoredDeletionResponseSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The idempotent deletion response snapshot is invalid.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["response", "snapshotKind", "tenantId"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    record.snapshotKind !== "deletion_job_v1" ||
    typeof record.tenantId !== "string"
  ) {
    throw new Error("The idempotent deletion response snapshot is invalid.");
  }
  return record as unknown as StoredDeletionResponseSnapshot;
}

/**
 * Reauthentication passwords are transient proofs, not mutation semantics.
 * Including one in a persisted fast digest would create an offline password
 * oracle and bypass the deliberately expensive PasswordHasher boundary.
 */
function hashProjectDeletionSubmission(
  projectId: string,
  request: CloudDeletionSubmissionRequest,
): string {
  return hashCanonicalJson({
    confirmationId: request.confirmationId,
    expectedRevision: request.expectedRevision,
    projectId,
    schemaVersion: request.schemaVersion,
    targetKind: "project",
  });
}

function hashAccountDeletionSubmission(
  accountId: string,
  request: CloudAccountDeletionSubmissionRequest,
): string {
  return hashCanonicalJson({
    confirmationId: request.confirmationId,
    email: request.email,
    expectedRevision: request.expectedRevision,
    schemaVersion: request.schemaVersion,
    targetId: accountId,
    targetKind: "account",
  });
}

function hashProjectDeletionCancellation(
  projectId: string,
  request: CloudDeletionCancellationRequest,
): string {
  return hashCanonicalJson({
    deletionRequestId: request.deletionRequestId,
    expectedDeletionRevision: request.expectedDeletionRevision,
    projectId,
    schemaVersion: request.schemaVersion,
    targetKind: "project",
  });
}

function hashAccountDeletionCancellation(request: CloudAccountDeletionCancellationRequest): string {
  return hashCanonicalJson({
    deletionRequestId: request.deletionRequestId,
    email: request.email,
    expectedDeletionRevision: request.expectedDeletionRevision,
    schemaVersion: request.schemaVersion,
    targetKind: "account",
  });
}

function personalTenantId(principal: CloudPrincipal): string {
  return principal.accountId;
}

function unwrap<Value>(outcome: ServiceOutcome<Value>): Value {
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  const result = new Date(value.getTime() + milliseconds);
  if (!Number.isFinite(result.getTime())) {
    throw new Error("Cloud deletion produced an invalid retention timestamp.");
  }
  return result;
}

function validateOptions(options: {
  readonly backupRetentionMs: number;
  readonly gracePeriodMs: number;
  readonly idempotencyLifetimeMs: number;
  readonly maximumOwnedProjects: number;
  readonly pageSize: number;
}): void {
  if (
    !Number.isSafeInteger(options.gracePeriodMs) ||
    options.gracePeriodMs < DAY_MS ||
    options.gracePeriodMs > 365 * DAY_MS
  ) {
    throw new Error("Cloud deletion grace period must be between 1 and 365 days.");
  }
  if (
    !Number.isSafeInteger(options.backupRetentionMs) ||
    options.backupRetentionMs < 0 ||
    options.backupRetentionMs > 3_650 * DAY_MS ||
    options.backupRetentionMs % 1_000 !== 0
  ) {
    throw new Error("Cloud deletion backup retention must be whole seconds up to ten years.");
  }
  if (!Number.isSafeInteger(options.idempotencyLifetimeMs) || options.idempotencyLifetimeMs <= 0) {
    throw new Error("Cloud deletion idempotency lifetime must be positive.");
  }
  if (
    !Number.isSafeInteger(options.maximumOwnedProjects) ||
    options.maximumOwnedProjects < 1 ||
    options.maximumOwnedProjects > 10_000
  ) {
    throw new Error("Cloud deletion owned-project bound is invalid.");
  }
  if (
    !Number.isSafeInteger(options.pageSize) ||
    options.pageSize < 1 ||
    options.pageSize > 1_000 ||
    options.pageSize > options.maximumOwnedProjects
  ) {
    throw new Error("Cloud deletion page size is invalid.");
  }
}
