import { createHash, createPublicKey, verify } from "node:crypto";

import type { ZodType } from "zod";

import {
  CloudMarketplaceAppealResponseSchema,
  CloudMarketplaceCatalogResponseSchema,
  CloudMarketplaceDownloadResponseSchema,
  CloudMarketplaceModerationQueueResponseSchema,
  CloudMarketplaceReportResponseSchema,
  CloudMarketplaceSubmissionResponseSchema,
  canonicalMarketplaceJson,
  expectedMarketplaceHighRiskConfirmation,
  marketplaceSubmissionSignaturePayload,
  type CloudMarketplaceAppealDispositionRequest,
  type CloudMarketplaceAppealRequest,
  type CloudMarketplaceAppealResponse,
  type CloudMarketplaceArtifactKind,
  type CloudMarketplaceArtifactSummary,
  type CloudMarketplaceCatalogResponse,
  type CloudMarketplaceDownloadRequest,
  type CloudMarketplaceDownloadResponse,
  type CloudMarketplaceModerationAction,
  type CloudMarketplaceModerationQueueResponse,
  type CloudMarketplaceModerationRequest,
  type CloudMarketplaceReportDispositionRequest,
  type CloudMarketplaceReportResponse,
  type CloudMarketplaceReportRequest,
  type CloudMarketplaceSubmissionRequest,
  type CloudMarketplaceSubmissionResponse,
  type CloudMarketplaceVersionMetadata,
  type CloudMarketplaceWithdrawalRequest,
} from "@inkshadow/contracts/marketplace";
import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";

import type {
  CloudMarketplaceActor,
  CloudMarketplaceAppealRecord,
  CloudMarketplaceArtifactRecord,
  CloudMarketplaceIdempotencyRecord,
  CloudMarketplaceModerationEventRecord,
  CloudMarketplacePageAnchor,
  CloudMarketplaceReportRecord,
  CloudMarketplaceVersionRecord,
} from "../domain/marketplace-records.js";
import type {
  CloudMarketplaceStore,
  CloudMarketplaceTransaction,
} from "../repository/marketplace-store.js";
import { InvalidMarketplaceCursorError } from "../security/marketplace-cursor.js";
import type { CloudMarketplaceCursorCodec } from "../security/marketplace-cursor.js";
import type { UuidV7Factory } from "../security/uuid-v7.js";
import {
  accessForbidden,
  idempotencyConflict,
  resourceNotFound,
  revisionConflict,
  serviceUnavailable,
  validationFailed,
  type CloudServiceError,
} from "./errors.js";
import type { CloudMutationContext, CloudReadContext } from "./identity-service.js";

const DEFAULT_IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const RESTRICTED_ARTIFACT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const DOWNLOAD_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const MODERATION_AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
const MAXIMUM_ARTIFACT_BYTES = 256 * 1024;
const MAXIMUM_PAGE_SIZE = 100;

type MutationOutcome<Output> = { readonly value: Output } | { readonly error: CloudServiceError };

export interface CloudMarketplaceServiceOptions {
  readonly clock?: () => Date;
  readonly cursorCodec: CloudMarketplaceCursorCodec;
  readonly enabled?: boolean;
  readonly idempotencyLifetimeMs?: number;
  readonly store: CloudMarketplaceStore;
  readonly uuid: UuidV7Factory;
}

export class CloudMarketplaceService {
  private readonly clock: () => Date;
  private readonly cursorCodec: CloudMarketplaceCursorCodec;
  private readonly enabled: boolean;
  private readonly idempotencyLifetimeMs: number;
  private readonly store: CloudMarketplaceStore;
  private readonly uuid: UuidV7Factory;

  public constructor(options: CloudMarketplaceServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.cursorCodec = options.cursorCodec;
    this.enabled = options.enabled ?? false;
    this.idempotencyLifetimeMs = options.idempotencyLifetimeMs ?? DEFAULT_IDEMPOTENCY_LIFETIME_MS;
    this.store = options.store;
    this.uuid = options.uuid;
    if (!Number.isSafeInteger(this.idempotencyLifetimeMs) || this.idempotencyLifetimeMs <= 0) {
      throw new Error("Marketplace idempotency lifetime must be a positive integer.");
    }
  }

  public async submitVersion(
    actor: CloudMarketplaceActor,
    request: CloudMarketplaceSubmissionRequest,
    context: CloudMutationContext,
  ): Promise<CloudMarketplaceSubmissionResponse> {
    this.requireEnabled();
    requireMutationContext(context);
    if (request.authorAccountId !== actor.accountId) {
      throw accessForbidden();
    }
    const verified = verifySubmission(request);
    const now = this.now();
    const operationId = "marketplace.versions.submit";
    const requestHash = hashCanonical({ request });
    const outcome = await this.store.transaction<
      MutationOutcome<CloudMarketplaceSubmissionResponse>
    >(actor, async (transaction) => {
      const replay = await this.findReplay(
        transaction,
        actor,
        operationId,
        context,
        requestHash,
        CloudMarketplaceSubmissionResponseSchema,
      );
      if (replay !== null) {
        return { value: replay };
      }
      const existing = await transaction.findArtifact(request.artifactId, true);
      if (existing !== null) {
        if (
          existing.authorAccountId !== actor.accountId ||
          existing.pendingVersionId !== null ||
          existing.state === "appeal_pending" ||
          existing.latestVersionNumber >= Number.MAX_SAFE_INTEGER ||
          request.versionNumber !== existing.latestVersionNumber + 1
        ) {
          return { error: revisionConflict() };
        }
      } else if (request.versionNumber !== 1) {
        return { error: revisionConflict() };
      }
      if ((await transaction.findVersion(request.artifactId, request.versionId, true)) !== null) {
        return { error: revisionConflict() };
      }

      const version: CloudMarketplaceVersionRecord = {
        artifactId: request.artifactId,
        authorDisplayName: request.authorDisplayName,
        authorPublicKeySpki: request.authorPublicKeySpki,
        authorSignature: request.authorSignature,
        authorSigningKeyFingerprintSha256: verified.keyFingerprintSha256,
        content: request.content,
        contentBytes: verified.contentBytes,
        contentDigestSha256: request.contentDigestSha256,
        createdAt: now,
        kind: request.kind,
        license: request.license,
        publishedAt: null,
        quarantinedAt: null,
        retentionUntil: null,
        reviewedAt: null,
        semanticVersion: request.semanticVersion,
        state: "pending_review",
        submittedAt: now,
        summary: request.summary,
        tags: request.tags,
        title: request.title,
        versionId: request.versionId,
        versionNumber: request.versionNumber,
        withdrawnAt: null,
      };
      let artifact: CloudMarketplaceArtifactRecord;
      if (existing === null) {
        artifact = {
          artifactId: request.artifactId,
          authorAccountId: actor.accountId,
          authorDisplayName: request.authorDisplayName,
          createdAt: now,
          kind: request.kind,
          latestVersionNumber: request.versionNumber,
          license: request.license,
          pendingVersionId: request.versionId,
          publishedAt: null,
          publishedVersionId: null,
          quarantinedAt: null,
          retentionUntil: null,
          revision: 1,
          state: "pending_review",
          summary: request.summary,
          tags: request.tags,
          title: request.title,
          updatedAt: now,
          withdrawnAt: null,
        };
        await transaction.insertArtifact(artifact);
      } else {
        artifact = {
          ...existing,
          ...(existing.publishedVersionId === null
            ? {
                authorDisplayName: request.authorDisplayName,
                kind: request.kind,
                license: request.license,
                summary: request.summary,
                tags: request.tags,
                title: request.title,
              }
            : {}),
          latestVersionNumber: request.versionNumber,
          pendingVersionId: request.versionId,
          quarantinedAt: null,
          retentionUntil: null,
          revision: existing.revision + 1,
          state: existing.publishedVersionId === null ? "pending_review" : "published",
          updatedAt: now,
          withdrawnAt: null,
        };
        if (!(await transaction.updateArtifactCas(artifact, existing.revision))) {
          return { error: revisionConflict() };
        }
      }
      await transaction.insertVersion(version);
      const response = submissionResponse(artifact, version, context.requestId);
      await this.insertIdempotency(transaction, {
        actor,
        context,
        now,
        operationId,
        requestHash,
        response,
        responseStatus: 201,
      });
      return { value: response };
    });
    return unwrap(outcome);
  }

  public async listCatalog(
    actor: CloudMarketplaceActor,
    kind: CloudMarketplaceArtifactKind | null,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudMarketplaceCatalogResponse> {
    this.requireEnabled();
    const pageSize = requirePageSize(limit);
    const anchor = this.decodeCursor("catalog", cursor);
    return this.store.transaction(actor, async (transaction) => {
      const records = await transaction.listCatalog(pageSize + 1, anchor, kind);
      const page = records.slice(0, pageSize);
      const last = page.at(-1);
      return CloudMarketplaceCatalogResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        artifacts: page.map(toArtifactSummary),
        nextCursor:
          records.length > pageSize && last !== undefined
            ? this.cursorCodec.encode("catalog", artifactAnchor(last))
            : null,
      });
    });
  }

  public async moderateVersion(
    actor: CloudMarketplaceActor,
    artifactId: string,
    versionId: string,
    request: CloudMarketplaceModerationRequest,
    context: CloudMutationContext,
  ): Promise<CloudMarketplaceSubmissionResponse> {
    this.requireEnabled();
    requireMutationContext(context);
    const now = this.now();
    const operationId = `marketplace.moderation.${request.action}`;
    const requestHash = hashCanonical({ artifactId, request, versionId });
    const outcome = await this.store.transaction<
      MutationOutcome<CloudMarketplaceSubmissionResponse>
    >(actor, async (transaction) => {
      const denied = await this.requireHighRisk<CloudMarketplaceSubmissionResponse>(
        transaction,
        actor,
        request.action,
        artifactId,
        versionId,
        request.reason,
        request.confirmation,
        context,
        now,
      );
      if (denied !== null) {
        return denied;
      }
      const replay = await this.findReplay(
        transaction,
        actor,
        operationId,
        context,
        requestHash,
        CloudMarketplaceSubmissionResponseSchema,
      );
      if (replay !== null) {
        return { value: replay };
      }
      const current = await this.requireArtifactVersion(transaction, artifactId, versionId, true);
      if (current.artifact.revision !== request.expectedRevision) {
        return { error: revisionConflict() };
      }
      const transitioned = await this.applyModerationTransition(
        transaction,
        current.artifact,
        current.version,
        request.action,
        now,
      );
      if ("error" in transitioned) {
        return transitioned;
      }
      await transaction.insertModerationEvent(
        moderationEvent({
          action: request.action,
          actor,
          artifactId,
          confirmation: request.confirmation,
          context,
          now,
          reason: request.reason,
          result: "allowed",
          uuid: this.uuid,
          versionId,
        }),
      );
      const response = submissionResponse(
        transitioned.artifact,
        transitioned.version,
        context.requestId,
      );
      await this.insertIdempotency(transaction, {
        actor,
        context,
        now,
        operationId,
        requestHash,
        response,
        responseStatus: 200,
      });
      return { value: response };
    });
    return unwrap(outcome);
  }

  public async reportVersion(
    actor: CloudMarketplaceActor,
    artifactId: string,
    versionId: string,
    request: CloudMarketplaceReportRequest,
    context: CloudMutationContext,
  ): Promise<CloudMarketplaceReportResponse> {
    this.requireEnabled();
    requireMutationContext(context);
    const now = this.now();
    const operationId = "marketplace.reports.submit";
    const requestHash = hashCanonical({ artifactId, request, versionId });
    const outcome = await this.store.transaction<MutationOutcome<CloudMarketplaceReportResponse>>(
      actor,
      async (transaction) => {
        const replay = await this.findReplay(
          transaction,
          actor,
          operationId,
          context,
          requestHash,
          CloudMarketplaceReportResponseSchema,
        );
        if (replay !== null) {
          return { value: replay };
        }
        const current = await this.requireArtifactVersion(transaction, artifactId, versionId, true);
        if (
          current.artifact.state !== "published" ||
          current.artifact.publishedVersionId !== versionId ||
          current.version.state !== "published" ||
          (await transaction.findOpenReport(artifactId, versionId, actor.accountId)) !== null ||
          (await transaction.findReport(request.reportId, true)) !== null
        ) {
          return { error: revisionConflict() };
        }
        const retentionUntil = restrictedRetention(now);
        const report: CloudMarketplaceReportRecord = {
          artifactId,
          category: request.category,
          createdAt: now,
          reason: request.reason,
          reportId: request.reportId,
          reporterAccountId: actor.accountId,
          resolvedAt: null,
          retentionUntil,
          state: "open",
          versionId,
        };
        const version: CloudMarketplaceVersionRecord = {
          ...current.version,
          quarantinedAt: now,
          retentionUntil,
          state: "quarantined",
        };
        const artifact: CloudMarketplaceArtifactRecord = {
          ...current.artifact,
          quarantinedAt: now,
          retentionUntil,
          revision: current.artifact.revision + 1,
          state: "quarantined",
          updatedAt: now,
          withdrawnAt: null,
        };
        await transaction.insertReport(report);
        await transaction.updateVersion(version);
        if (!(await transaction.updateArtifactCas(artifact, current.artifact.revision))) {
          return { error: revisionConflict() };
        }
        const response = reportResponse(report, artifact, version, context.requestId);
        await this.insertIdempotency(transaction, {
          actor,
          context,
          now,
          operationId,
          requestHash,
          response,
          responseStatus: 201,
        });
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async withdrawVersion(
    actor: CloudMarketplaceActor,
    artifactId: string,
    versionId: string,
    request: CloudMarketplaceWithdrawalRequest,
    context: CloudMutationContext,
  ): Promise<CloudMarketplaceSubmissionResponse> {
    this.requireEnabled();
    requireMutationContext(context);
    const now = this.now();
    const operationId = "marketplace.versions.withdraw";
    const requestHash = hashCanonical({ artifactId, request, versionId });
    const outcome = await this.store.transaction<
      MutationOutcome<CloudMarketplaceSubmissionResponse>
    >(actor, async (transaction) => {
      const replay = await this.findReplay(
        transaction,
        actor,
        operationId,
        context,
        requestHash,
        CloudMarketplaceSubmissionResponseSchema,
      );
      if (replay !== null) {
        return { value: replay };
      }
      const current = await this.requireArtifactVersion(transaction, artifactId, versionId, true);
      if (
        current.artifact.authorAccountId !== actor.accountId ||
        current.artifact.revision !== request.expectedRevision ||
        !["pending_review", "published", "quarantined"].includes(current.version.state)
      ) {
        return { error: accessForbidden() };
      }
      const retentionUntil = restrictedRetention(now);
      const version: CloudMarketplaceVersionRecord = {
        ...current.version,
        quarantinedAt: null,
        retentionUntil,
        state: "author_withdrawn",
        withdrawnAt: now,
      };
      const withdrawingPending = current.artifact.pendingVersionId === versionId;
      const hasPriorPublished =
        withdrawingPending &&
        current.artifact.publishedVersionId !== null &&
        current.artifact.publishedVersionId !== versionId;
      const artifact: CloudMarketplaceArtifactRecord = {
        ...current.artifact,
        pendingVersionId: withdrawingPending ? null : current.artifact.pendingVersionId,
        publishedVersionId:
          current.artifact.publishedVersionId === versionId
            ? null
            : current.artifact.publishedVersionId,
        quarantinedAt: null,
        retentionUntil: hasPriorPublished ? null : retentionUntil,
        revision: current.artifact.revision + 1,
        state: hasPriorPublished ? "published" : "author_withdrawn",
        updatedAt: now,
        withdrawnAt: hasPriorPublished ? null : now,
      };
      await transaction.updateVersion(version);
      if (!(await transaction.updateArtifactCas(artifact, current.artifact.revision))) {
        return { error: revisionConflict() };
      }
      const response = submissionResponse(artifact, version, context.requestId);
      await this.insertIdempotency(transaction, {
        actor,
        context,
        now,
        operationId,
        requestHash,
        response,
        responseStatus: 200,
      });
      return { value: response };
    });
    return unwrap(outcome);
  }

  public async appealVersion(
    actor: CloudMarketplaceActor,
    artifactId: string,
    versionId: string,
    request: CloudMarketplaceAppealRequest,
    context: CloudMutationContext,
  ): Promise<CloudMarketplaceAppealResponse> {
    this.requireEnabled();
    requireMutationContext(context);
    const now = this.now();
    const operationId = "marketplace.appeals.submit";
    const requestHash = hashCanonical({ artifactId, request, versionId });
    const outcome = await this.store.transaction<MutationOutcome<CloudMarketplaceAppealResponse>>(
      actor,
      async (transaction) => {
        const replay = await this.findReplay(
          transaction,
          actor,
          operationId,
          context,
          requestHash,
          CloudMarketplaceAppealResponseSchema,
        );
        if (replay !== null) {
          return { value: replay };
        }
        const current = await this.requireArtifactVersion(transaction, artifactId, versionId, true);
        if (
          current.artifact.authorAccountId !== actor.accountId ||
          current.artifact.revision !== request.expectedRevision ||
          !["quarantined", "rejected"].includes(current.version.state) ||
          (await transaction.findOpenAppeal(artifactId, versionId)) !== null ||
          (await transaction.findAppeal(request.appealId, true)) !== null ||
          (await transaction.countOpenReports(artifactId, versionId)) !== 0
        ) {
          return { error: revisionConflict() };
        }
        const sourceState = current.version.state as "quarantined" | "rejected";
        const retentionUntil = restrictedRetention(now);
        const appeal: CloudMarketplaceAppealRecord = {
          appealId: request.appealId,
          artifactId,
          authorAccountId: actor.accountId,
          createdAt: now,
          reason: request.reason,
          resolvedAt: null,
          retentionUntil,
          sourceState,
          state: "open",
          versionId,
        };
        const version: CloudMarketplaceVersionRecord = {
          ...current.version,
          quarantinedAt: null,
          retentionUntil,
          state: "appeal_pending",
        };
        const artifact: CloudMarketplaceArtifactRecord = {
          ...current.artifact,
          quarantinedAt: null,
          retentionUntil,
          revision: current.artifact.revision + 1,
          state: "appeal_pending",
          updatedAt: now,
        };
        await transaction.insertAppeal(appeal);
        await transaction.updateVersion(version);
        if (!(await transaction.updateArtifactCas(artifact, current.artifact.revision))) {
          return { error: revisionConflict() };
        }
        const response = appealResponse(appeal, artifact, version, context.requestId);
        await this.insertIdempotency(transaction, {
          actor,
          context,
          now,
          operationId,
          requestHash,
          response,
          responseStatus: 201,
        });
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async disposeReport(
    actor: CloudMarketplaceActor,
    reportId: string,
    request: CloudMarketplaceReportDispositionRequest,
    context: CloudMutationContext,
  ): Promise<CloudMarketplaceReportResponse> {
    this.requireEnabled();
    requireMutationContext(context);
    const now = this.now();
    const action = `report_${request.disposition}`;
    const operationId = `marketplace.reports.${request.disposition}`;
    const requestHash = hashCanonical({ reportId, request });
    const outcome = await this.store.transaction<MutationOutcome<CloudMarketplaceReportResponse>>(
      actor,
      async (transaction) => {
        const denied = await this.requireHighRisk<CloudMarketplaceReportResponse>(
          transaction,
          actor,
          action,
          reportId,
          reportId,
          request.reason,
          request.confirmation,
          context,
          now,
        );
        if (denied !== null) {
          return denied;
        }
        const replay = await this.findReplay(
          transaction,
          actor,
          operationId,
          context,
          requestHash,
          CloudMarketplaceReportResponseSchema,
        );
        if (replay !== null) {
          return { value: replay };
        }
        const report = await transaction.findReport(reportId, true);
        if (report === null) {
          return { error: resourceNotFound() };
        }
        const current = await this.requireArtifactVersion(
          transaction,
          report.artifactId,
          report.versionId,
          true,
        );
        if (report.state !== "open" || current.artifact.revision !== request.expectedRevision) {
          return { error: revisionConflict() };
        }
        const updatedReport: CloudMarketplaceReportRecord = {
          ...report,
          resolvedAt: now,
          retentionUntil: restrictedRetention(now),
          state: request.disposition === "dismiss" ? "dismissed" : "upheld",
        };
        await transaction.updateReport(updatedReport);
        let artifact = current.artifact;
        let version = current.version;
        const remainingReports = await transaction.countOpenReports(
          report.artifactId,
          report.versionId,
        );
        if (
          request.disposition === "dismiss" &&
          remainingReports === 0 &&
          current.artifact.state === "quarantined" &&
          current.version.state === "quarantined"
        ) {
          version = {
            ...current.version,
            publishedAt: current.version.publishedAt ?? now,
            quarantinedAt: null,
            retentionUntil: null,
            state: "published",
          };
          artifact = {
            ...current.artifact,
            publishedVersionId: current.version.versionId,
            quarantinedAt: null,
            retentionUntil: null,
            revision: current.artifact.revision + 1,
            state: "published",
            updatedAt: now,
          };
          await transaction.updateVersion(version);
          if (!(await transaction.updateArtifactCas(artifact, current.artifact.revision))) {
            return { error: revisionConflict() };
          }
        }
        await transaction.insertModerationEvent(
          moderationEvent({
            action,
            actor,
            artifactId: report.artifactId,
            confirmation: request.confirmation,
            context,
            now,
            reason: request.reason,
            result: "allowed",
            uuid: this.uuid,
            versionId: report.versionId,
          }),
        );
        const response = reportResponse(updatedReport, artifact, version, context.requestId);
        await this.insertIdempotency(transaction, {
          actor,
          context,
          now,
          operationId,
          requestHash,
          response,
          responseStatus: 200,
        });
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async disposeAppeal(
    actor: CloudMarketplaceActor,
    appealId: string,
    request: CloudMarketplaceAppealDispositionRequest,
    context: CloudMutationContext,
  ): Promise<CloudMarketplaceAppealResponse> {
    this.requireEnabled();
    requireMutationContext(context);
    const now = this.now();
    const action = `appeal_${request.disposition}`;
    const operationId = `marketplace.appeals.${request.disposition}`;
    const requestHash = hashCanonical({ appealId, request });
    const outcome = await this.store.transaction<MutationOutcome<CloudMarketplaceAppealResponse>>(
      actor,
      async (transaction) => {
        const denied = await this.requireHighRisk<CloudMarketplaceAppealResponse>(
          transaction,
          actor,
          action,
          appealId,
          appealId,
          request.reason,
          request.confirmation,
          context,
          now,
        );
        if (denied !== null) {
          return denied;
        }
        const replay = await this.findReplay(
          transaction,
          actor,
          operationId,
          context,
          requestHash,
          CloudMarketplaceAppealResponseSchema,
        );
        if (replay !== null) {
          return { value: replay };
        }
        const appeal = await transaction.findAppeal(appealId, true);
        if (appeal === null) {
          return { error: resourceNotFound() };
        }
        const current = await this.requireArtifactVersion(
          transaction,
          appeal.artifactId,
          appeal.versionId,
          true,
        );
        if (
          appeal.state !== "open" ||
          current.artifact.revision !== request.expectedRevision ||
          current.version.state !== "appeal_pending"
        ) {
          return { error: revisionConflict() };
        }
        const accepted = request.disposition === "accept";
        const updatedAppeal: CloudMarketplaceAppealRecord = {
          ...appeal,
          resolvedAt: now,
          retentionUntil: restrictedRetention(now),
          state: accepted ? "accepted" : "denied",
        };
        let version: CloudMarketplaceVersionRecord;
        let artifact: CloudMarketplaceArtifactRecord;
        if (accepted) {
          await transaction.supersedePublishedVersion(appeal.artifactId, appeal.versionId, now);
          version = {
            ...current.version,
            publishedAt: current.version.publishedAt ?? now,
            quarantinedAt: null,
            retentionUntil: null,
            reviewedAt: now,
            state: "published",
          };
          artifact = publishArtifact(current.artifact, version, now);
        } else {
          const retentionUntil = restrictedRetention(now);
          version = {
            ...current.version,
            quarantinedAt: appeal.sourceState === "quarantined" ? now : null,
            retentionUntil,
            state: appeal.sourceState,
          };
          artifact = {
            ...current.artifact,
            pendingVersionId:
              appeal.sourceState === "rejected" ? null : current.artifact.pendingVersionId,
            quarantinedAt: appeal.sourceState === "quarantined" ? now : null,
            retentionUntil,
            revision: current.artifact.revision + 1,
            state: appeal.sourceState,
            updatedAt: now,
          };
        }
        await transaction.updateAppeal(updatedAppeal);
        await transaction.updateVersion(version);
        if (!(await transaction.updateArtifactCas(artifact, current.artifact.revision))) {
          return { error: revisionConflict() };
        }
        await transaction.insertModerationEvent(
          moderationEvent({
            action,
            actor,
            artifactId: appeal.artifactId,
            confirmation: request.confirmation,
            context,
            now,
            reason: request.reason,
            result: "allowed",
            uuid: this.uuid,
            versionId: appeal.versionId,
          }),
        );
        const response = appealResponse(updatedAppeal, artifact, version, context.requestId);
        await this.insertIdempotency(transaction, {
          actor,
          context,
          now,
          operationId,
          requestHash,
          response,
          responseStatus: 200,
        });
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async download(
    actor: CloudMarketplaceActor,
    artifactId: string,
    request: CloudMarketplaceDownloadRequest,
    context: CloudMutationContext,
  ): Promise<CloudMarketplaceDownloadResponse> {
    this.requireEnabled();
    requireMutationContext(context);
    if (actor.platformRole === "platform_ops") {
      throw accessForbidden("Platform operations sessions cannot access marketplace bodies.");
    }
    const now = this.now();
    const operationId = "marketplace.downloads.create";
    const requestHash = hashCanonical({ artifactId, request });
    const outcome = await this.store.transaction<MutationOutcome<CloudMarketplaceDownloadResponse>>(
      actor,
      async (transaction) => {
        const current = await this.requireArtifactVersion(
          transaction,
          artifactId,
          request.versionId,
          false,
        );
        if (
          current.artifact.state !== "published" ||
          current.artifact.publishedVersionId !== request.versionId ||
          current.version.state !== "published" ||
          current.version.content === null ||
          current.version.authorPublicKeySpki === null ||
          current.version.authorSignature === null
        ) {
          return { error: resourceNotFound() };
        }
        const replay = await this.findReplay(
          transaction,
          actor,
          operationId,
          context,
          requestHash,
          CloudMarketplaceDownloadResponseSchema,
        );
        if (replay !== null) {
          return { value: replay };
        }
        const downloadAuditId = this.uuid();
        const retentionUntil = new Date(now.getTime() + DOWNLOAD_AUDIT_RETENTION_MS);
        await transaction.insertDownloadAudit({
          accountId: actor.accountId,
          artifactId,
          contentDigestSha256: current.version.contentDigestSha256,
          createdAt: now,
          downloadAuditId,
          requestId: context.requestId,
          retentionUntil,
          versionId: request.versionId,
        });
        const response = CloudMarketplaceDownloadResponseSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: context.requestId,
          downloadAuditId,
          retentionUntil: retentionUntil.toISOString(),
          artifact: toArtifactSummary(current.artifact),
          version: toVersionMetadata(current.version),
          content: current.version.content,
          authorPublicKeySpki: current.version.authorPublicKeySpki,
          authorSignature: current.version.authorSignature,
        });
        await this.insertIdempotency(transaction, {
          actor,
          context,
          now,
          operationId,
          requestHash,
          response,
          responseStatus: 200,
        });
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async listModerationQueue(
    actor: CloudMarketplaceActor,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudMarketplaceModerationQueueResponse> {
    this.requireEnabled();
    if (actor.platformRole !== "platform_ops") {
      throw accessForbidden();
    }
    const pageSize = requirePageSize(limit);
    const anchor = this.decodeCursor("moderation_queue", cursor);
    return this.store.transaction(actor, async (transaction) => {
      const records = await transaction.listModerationQueue(pageSize + 1, anchor);
      const page = records.slice(0, pageSize);
      const last = page.at(-1);
      return CloudMarketplaceModerationQueueResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        items: page.map((record) => ({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          artifact: toArtifactSummary(record.artifact),
          version: toVersionMetadata(record.version),
          openReportCount: record.openReportCount,
          openAppealId: record.appeal?.appealId ?? null,
        })),
        nextCursor:
          records.length > pageSize && last !== undefined
            ? this.cursorCodec.encode("moderation_queue", versionAnchor(last.version))
            : null,
      });
    });
  }

  private async applyModerationTransition(
    transaction: CloudMarketplaceTransaction,
    existingArtifact: CloudMarketplaceArtifactRecord,
    existingVersion: CloudMarketplaceVersionRecord,
    action: CloudMarketplaceModerationAction,
    now: Date,
  ): Promise<
    | {
        readonly artifact: CloudMarketplaceArtifactRecord;
        readonly version: CloudMarketplaceVersionRecord;
      }
    | { readonly error: CloudServiceError }
  > {
    let artifact: CloudMarketplaceArtifactRecord;
    let version: CloudMarketplaceVersionRecord;
    switch (action) {
      case "approve": {
        if (
          existingVersion.state !== "pending_review" ||
          existingArtifact.pendingVersionId !== existingVersion.versionId
        ) {
          return { error: revisionConflict() };
        }
        await transaction.supersedePublishedVersion(
          existingArtifact.artifactId,
          existingVersion.versionId,
          now,
        );
        version = {
          ...existingVersion,
          publishedAt: now,
          quarantinedAt: null,
          retentionUntil: null,
          reviewedAt: now,
          state: "published",
          withdrawnAt: null,
        };
        artifact = publishArtifact(existingArtifact, version, now);
        break;
      }
      case "reject": {
        if (
          existingVersion.state !== "pending_review" ||
          existingArtifact.pendingVersionId !== existingVersion.versionId
        ) {
          return { error: revisionConflict() };
        }
        const retentionUntil = restrictedRetention(now);
        version = {
          ...existingVersion,
          retentionUntil,
          reviewedAt: now,
          state: "rejected",
        };
        artifact = {
          ...existingArtifact,
          pendingVersionId: null,
          quarantinedAt: null,
          retentionUntil: existingArtifact.publishedVersionId === null ? retentionUntil : null,
          revision: existingArtifact.revision + 1,
          state: existingArtifact.publishedVersionId === null ? "rejected" : "published",
          updatedAt: now,
          withdrawnAt: null,
        };
        break;
      }
      case "quarantine": {
        if (
          existingVersion.state !== "published" ||
          existingArtifact.publishedVersionId !== existingVersion.versionId
        ) {
          return { error: revisionConflict() };
        }
        const retentionUntil = restrictedRetention(now);
        version = {
          ...existingVersion,
          quarantinedAt: now,
          retentionUntil,
          reviewedAt: now,
          state: "quarantined",
        };
        artifact = {
          ...existingArtifact,
          quarantinedAt: now,
          retentionUntil,
          revision: existingArtifact.revision + 1,
          state: "quarantined",
          updatedAt: now,
          withdrawnAt: null,
        };
        break;
      }
      case "restore": {
        if (
          existingVersion.state !== "quarantined" ||
          existingArtifact.publishedVersionId !== existingVersion.versionId ||
          (await transaction.countOpenReports(
            existingArtifact.artifactId,
            existingVersion.versionId,
          )) !== 0
        ) {
          return { error: revisionConflict() };
        }
        version = {
          ...existingVersion,
          publishedAt: existingVersion.publishedAt ?? now,
          quarantinedAt: null,
          retentionUntil: null,
          reviewedAt: now,
          state: "published",
        };
        artifact = {
          ...existingArtifact,
          quarantinedAt: null,
          retentionUntil: null,
          revision: existingArtifact.revision + 1,
          state: "published",
          updatedAt: now,
        };
        break;
      }
    }
    await transaction.updateVersion(version);
    if (!(await transaction.updateArtifactCas(artifact, existingArtifact.revision))) {
      return { error: revisionConflict() };
    }
    return { artifact, version };
  }

  private async requireArtifactVersion(
    transaction: CloudMarketplaceTransaction,
    artifactId: string,
    versionId: string,
    forUpdate: boolean,
  ): Promise<{
    readonly artifact: CloudMarketplaceArtifactRecord;
    readonly version: CloudMarketplaceVersionRecord;
  }> {
    const artifact = await transaction.findArtifact(artifactId, forUpdate);
    const version = await transaction.findVersion(artifactId, versionId, forUpdate);
    if (artifact === null || version === null) {
      throw resourceNotFound();
    }
    return { artifact, version };
  }

  private async requireHighRisk<Output>(
    transaction: CloudMarketplaceTransaction,
    actor: CloudMarketplaceActor,
    action: string,
    artifactId: string,
    confirmationResourceId: string,
    reason: string,
    confirmation: string,
    context: CloudMutationContext,
    now: Date,
  ): Promise<MutationOutcome<Output> | null> {
    const authorized =
      actor.platformRole === "platform_ops" &&
      actor.strongMfa &&
      confirmation === expectedMarketplaceHighRiskConfirmation(action, confirmationResourceId);
    if (authorized) {
      return null;
    }
    await transaction.insertModerationEvent(
      moderationEvent({
        action,
        actor,
        artifactId,
        confirmation,
        context,
        now,
        reason,
        result: "denied",
        uuid: this.uuid,
        versionId: confirmationResourceId,
      }),
    );
    return { error: accessForbidden() };
  }

  private async findReplay<Output>(
    transaction: CloudMarketplaceTransaction,
    actor: CloudMarketplaceActor,
    operationId: string,
    context: CloudMutationContext,
    requestHash: string,
    schema: ZodType<Output>,
  ): Promise<Output | null> {
    const scopeHash = idempotencyScopeHash(actor.accountId, operationId, context.idempotencyKey);
    await transaction.lockIdempotency(scopeHash);
    const existing = await transaction.findIdempotency(scopeHash);
    if (existing === null || existing.expiresAt.getTime() <= this.now().getTime()) {
      return null;
    }
    if (
      existing.actorAccountId !== actor.accountId ||
      existing.operationId !== operationId ||
      existing.requestHashSha256 !== requestHash ||
      hashCanonical(existing.responseSnapshot) !== existing.resultDigestSha256
    ) {
      throw idempotencyConflict();
    }
    if (typeof existing.responseSnapshot !== "object" || existing.responseSnapshot === null) {
      throw new Error("Marketplace idempotency snapshot is internally inconsistent.");
    }
    return schema.parse({ ...existing.responseSnapshot, requestId: context.requestId });
  }

  private insertIdempotency(
    transaction: CloudMarketplaceTransaction,
    options: {
      readonly actor: CloudMarketplaceActor;
      readonly context: CloudMutationContext;
      readonly now: Date;
      readonly operationId: string;
      readonly requestHash: string;
      readonly response: unknown;
      readonly responseStatus: number;
    },
  ): Promise<void> {
    const record: CloudMarketplaceIdempotencyRecord = {
      actorAccountId: options.actor.accountId,
      createdAt: options.now,
      expiresAt: new Date(options.now.getTime() + this.idempotencyLifetimeMs),
      operationId: options.operationId,
      requestHashSha256: options.requestHash,
      responseSnapshot: options.response,
      responseStatus: options.responseStatus,
      resultDigestSha256: hashCanonical(options.response),
      scopeHashSha256: idempotencyScopeHash(
        options.actor.accountId,
        options.operationId,
        options.context.idempotencyKey,
      ),
    };
    return transaction.insertIdempotency(record);
  }

  private decodeCursor(
    kind: "catalog" | "moderation_queue",
    cursor: string | null,
  ): CloudMarketplacePageAnchor | null {
    if (cursor === null) {
      return null;
    }
    try {
      return this.cursorCodec.decode(kind, cursor);
    } catch (error: unknown) {
      if (error instanceof InvalidMarketplaceCursorError) {
        throw validationFailed("The marketplace page cursor is invalid.");
      }
      throw error;
    }
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw serviceUnavailable();
    }
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("Marketplace service clock returned an invalid timestamp.");
    }
    return new Date(value);
  }
}

function verifySubmission(request: CloudMarketplaceSubmissionRequest): {
  readonly contentBytes: number;
  readonly keyFingerprintSha256: string;
} {
  const signaturePayload = Buffer.from(
    canonicalMarketplaceJson(marketplaceSubmissionSignaturePayload(request)),
    "utf8",
  );
  const contentBytes = Buffer.byteLength(canonicalMarketplaceJson(request.content), "utf8");
  if (contentBytes <= 0 || contentBytes > MAXIMUM_ARTIFACT_BYTES) {
    signaturePayload.fill(0);
    throw validationFailed("Marketplace artifact content exceeds the safe size limit.");
  }
  const expectedDigest = createHash("sha256").update(signaturePayload).digest("hex");
  if (expectedDigest !== request.contentDigestSha256) {
    signaturePayload.fill(0);
    throw validationFailed("Marketplace artifact digest verification failed.");
  }
  let publicKeyBytes: Buffer;
  let signatureBytes: Buffer;
  try {
    publicKeyBytes = decodeCanonicalBase64Url(request.authorPublicKeySpki);
    signatureBytes = decodeCanonicalBase64Url(request.authorSignature);
  } catch {
    signaturePayload.fill(0);
    throw validationFailed("Marketplace author signature encoding is invalid.");
  }
  try {
    const publicKey = createPublicKey({
      key: publicKeyBytes,
      format: "der",
      type: "spki",
    });
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      signatureBytes.length !== 64 ||
      !verify(null, signaturePayload, publicKey, signatureBytes)
    ) {
      throw validationFailed("Marketplace author signature verification failed.");
    }
    return {
      contentBytes,
      keyFingerprintSha256: createHash("sha256").update(publicKeyBytes).digest("hex"),
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "CloudServiceError") {
      throw error;
    }
    throw validationFailed("Marketplace author signature verification failed.");
  } finally {
    signaturePayload.fill(0);
    publicKeyBytes.fill(0);
    signatureBytes.fill(0);
  }
}

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new Error("Non-canonical base64url.");
  }
  return decoded;
}

function publishArtifact(
  artifact: CloudMarketplaceArtifactRecord,
  version: CloudMarketplaceVersionRecord,
  now: Date,
): CloudMarketplaceArtifactRecord {
  return {
    ...artifact,
    authorDisplayName: version.authorDisplayName,
    kind: version.kind,
    license: version.license,
    pendingVersionId: null,
    publishedAt: now,
    publishedVersionId: version.versionId,
    quarantinedAt: null,
    retentionUntil: null,
    revision: artifact.revision + 1,
    state: "published",
    summary: version.summary,
    tags: version.tags,
    title: version.title,
    updatedAt: now,
    withdrawnAt: null,
  };
}

function submissionResponse(
  artifact: CloudMarketplaceArtifactRecord,
  version: CloudMarketplaceVersionRecord,
  requestId: string,
): CloudMarketplaceSubmissionResponse {
  return CloudMarketplaceSubmissionResponseSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    artifact: toArtifactSummary(artifact),
    version: toVersionMetadata(version),
  });
}

function reportResponse(
  report: CloudMarketplaceReportRecord,
  artifact: CloudMarketplaceArtifactRecord,
  version: CloudMarketplaceVersionRecord,
  requestId: string,
): CloudMarketplaceReportResponse {
  return CloudMarketplaceReportResponseSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    report: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      reportId: report.reportId,
      artifactId: report.artifactId,
      versionId: report.versionId,
      reporterAccountId: report.reporterAccountId,
      category: report.category,
      state: report.state,
      createdAt: report.createdAt.toISOString(),
      resolvedAt: report.resolvedAt?.toISOString() ?? null,
      retentionUntil: report.retentionUntil.toISOString(),
    },
    artifact: toArtifactSummary(artifact),
    version: toVersionMetadata(version),
  });
}

function appealResponse(
  appeal: CloudMarketplaceAppealRecord,
  artifact: CloudMarketplaceArtifactRecord,
  version: CloudMarketplaceVersionRecord,
  requestId: string,
): CloudMarketplaceAppealResponse {
  return CloudMarketplaceAppealResponseSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    appeal: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      appealId: appeal.appealId,
      artifactId: appeal.artifactId,
      versionId: appeal.versionId,
      authorAccountId: appeal.authorAccountId,
      sourceState: appeal.sourceState,
      state: appeal.state,
      createdAt: appeal.createdAt.toISOString(),
      resolvedAt: appeal.resolvedAt?.toISOString() ?? null,
      retentionUntil: appeal.retentionUntil.toISOString(),
    },
    artifact: toArtifactSummary(artifact),
    version: toVersionMetadata(version),
  });
}

function toArtifactSummary(
  record: CloudMarketplaceArtifactRecord,
): CloudMarketplaceArtifactSummary {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId: record.artifactId,
    authorAccountId: record.authorAccountId,
    authorDisplayName: record.authorDisplayName,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    tags: [...record.tags],
    license: record.license,
    state: record.state,
    revision: record.revision,
    latestVersionNumber: record.latestVersionNumber,
    pendingVersionId: record.pendingVersionId,
    publishedVersionId: record.publishedVersionId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    publishedAt: record.publishedAt?.toISOString() ?? null,
    quarantinedAt: record.quarantinedAt?.toISOString() ?? null,
    withdrawnAt: record.withdrawnAt?.toISOString() ?? null,
    retentionUntil: record.retentionUntil?.toISOString() ?? null,
  };
}

function toVersionMetadata(record: CloudMarketplaceVersionRecord): CloudMarketplaceVersionMetadata {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId: record.artifactId,
    versionId: record.versionId,
    versionNumber: record.versionNumber,
    semanticVersion: record.semanticVersion,
    state: record.state,
    contentDigestSha256: record.contentDigestSha256,
    authorSigningKeyFingerprintSha256: record.authorSigningKeyFingerprintSha256,
    contentBytes: record.contentBytes,
    createdAt: record.createdAt.toISOString(),
    submittedAt: record.submittedAt.toISOString(),
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    publishedAt: record.publishedAt?.toISOString() ?? null,
    quarantinedAt: record.quarantinedAt?.toISOString() ?? null,
    withdrawnAt: record.withdrawnAt?.toISOString() ?? null,
    retentionUntil: record.retentionUntil?.toISOString() ?? null,
  };
}

function moderationEvent(options: {
  readonly action: string;
  readonly actor: CloudMarketplaceActor;
  readonly artifactId: string;
  readonly confirmation: string;
  readonly context: CloudReadContext;
  readonly now: Date;
  readonly reason: string;
  readonly result: CloudMarketplaceModerationEventRecord["result"];
  readonly uuid: UuidV7Factory;
  readonly versionId: string;
}): CloudMarketplaceModerationEventRecord {
  return {
    action: options.action,
    actorAccountId: options.actor.accountId,
    artifactId: options.artifactId,
    confirmationSha256: hashUtf8(options.confirmation),
    createdAt: options.now,
    eventId: options.uuid(),
    reason: options.reason,
    requestId: options.context.requestId,
    result: options.result,
    retentionUntil: new Date(options.now.getTime() + MODERATION_AUDIT_RETENTION_MS),
    versionId: options.versionId,
  };
}

function artifactAnchor(record: CloudMarketplaceArtifactRecord): CloudMarketplacePageAnchor {
  return { createdAt: record.updatedAt, id: record.artifactId };
}

function versionAnchor(record: CloudMarketplaceVersionRecord): CloudMarketplacePageAnchor {
  return { createdAt: record.submittedAt, id: record.versionId };
}

function requirePageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_PAGE_SIZE) {
    throw validationFailed("Marketplace page size is invalid.");
  }
  return value;
}

function requireMutationContext(context: CloudMutationContext): void {
  if (context.idempotencyKey.trim().length < 8 || context.idempotencyKey.length > 200) {
    throw validationFailed("Marketplace mutations require a stable idempotency key.");
  }
}

function restrictedRetention(now: Date): Date {
  return new Date(now.getTime() + RESTRICTED_ARTIFACT_RETENTION_MS);
}

function idempotencyScopeHash(
  accountId: string,
  operationId: string,
  idempotencyKey: string,
): string {
  return hashCanonical({
    accountId,
    operationId,
    idempotencyKeyHashSha256: hashUtf8(idempotencyKey),
  });
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalMarketplaceJson(value), "utf8").digest("hex");
}

function hashUtf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function unwrap<Output>(outcome: MutationOutcome<Output>): Output {
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
