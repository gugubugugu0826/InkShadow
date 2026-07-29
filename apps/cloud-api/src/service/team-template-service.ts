import { createHash } from "node:crypto";

import {
  authorizeTeamAction,
  type AccessAction,
  type AccessDecision,
  type TeamMembership,
} from "@inkshadow/access-core";
import {
  CloudTeamTemplateApplicationResponseSchema,
  CloudTeamTemplateListResponseSchema,
  CloudTeamTemplateMutationResponseSchema,
  CloudTeamTemplateResponseSchema,
  CloudTeamTemplateVersionListResponseSchema,
  CloudTeamTemplateVersionResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudApiOperationId,
  type CloudTeamTemplateApplicationResponse,
  type CloudTeamTemplateApplyRequest,
  type CloudTeamTemplateArchiveRequest,
  type CloudTeamTemplateCloneRequest,
  type CloudTeamTemplateCreateRequest,
  type CloudTeamTemplateListResponse,
  type CloudTeamTemplateMutationResponse,
  type CloudTeamTemplatePublishRequest,
  type CloudTeamTemplateResponse,
  type CloudTeamTemplateSummary,
  type CloudTeamTemplateVersion,
  type CloudTeamTemplateVersionCreateRequest,
  type CloudTeamTemplateVersionListResponse,
  type CloudTeamTemplateVersionResponse,
  type CloudTeamTemplateVersionSummary,
} from "@inkshadow/contracts";

import type { CloudProjectRecord } from "../domain/project-records.js";
import type { CloudIdempotencyRecord, CloudPageAnchor } from "../domain/records.js";
import type {
  CloudTeamTemplateApplicationRecord,
  CloudTeamTemplateRecord,
  CloudTeamTemplateVersionRecord,
} from "../domain/team-template-records.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamAuditEventRecord,
  CloudTeamMembershipRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type {
  CloudTeamTemplateStore,
  CloudTeamTemplateTransaction,
} from "../repository/team-template-store.js";
import {
  createIdempotencyScopeHash,
  hashCanonicalJson,
  hashUtf8,
} from "../security/canonical-hash.js";
import { InvalidPageCursorError } from "../security/page-cursor.js";
import type { CloudPageCursorCodec, CloudPageCursorKind } from "../security/page-cursor.js";
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

interface TeamTemplateScope {
  readonly actor: CloudTeamMembershipRecord;
  readonly assignment: CloudProjectAssignmentRecord;
  readonly project: CloudProjectRecord;
  readonly team: CloudTeamRecord;
}

type MutationOutcome<Output> = { readonly value: Output } | { readonly error: CloudServiceError };

interface MutationResult<Output> {
  readonly response: Output;
  readonly resultResourceId: string;
  readonly audit: Readonly<{
    action: string;
    redactedDiff: Readonly<Record<string, unknown>>;
    resourceId: string;
    resourceType: CloudTeamAuditEventRecord["resourceType"];
  }>;
}

export interface CloudTeamTemplateServiceOptions {
  readonly clock?: () => Date;
  readonly idempotencyLifetimeMs?: number;
  readonly pageCursorCodec: CloudPageCursorCodec;
  readonly store: CloudTeamTemplateStore;
  readonly uuid: UuidV7Factory;
}

/**
 * Metadata-only cloud control plane for project-bound encrypted team templates.
 *
 * The service verifies exact AEAD scope, ciphertext integrity, active project
 * key metadata, membership/assignment state, role actions and template CAS.
 * It never receives a template title, prompt, rule, checklist or project DEK.
 */
export class CloudTeamTemplateService {
  private readonly clock: () => Date;
  private readonly idempotencyLifetimeMs: number;
  private readonly pageCursorCodec: CloudPageCursorCodec;
  private readonly store: CloudTeamTemplateStore;
  private readonly uuid: UuidV7Factory;

  public constructor(options: CloudTeamTemplateServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.idempotencyLifetimeMs = options.idempotencyLifetimeMs ?? DEFAULT_IDEMPOTENCY_LIFETIME_MS;
    this.pageCursorCodec = options.pageCursorCodec;
    this.store = options.store;
    this.uuid = options.uuid;
    if (!Number.isSafeInteger(this.idempotencyLifetimeMs) || this.idempotencyLifetimeMs <= 0) {
      throw new Error("The team-template idempotency lifetime must be a positive integer.");
    }
  }

  public async createTemplate(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    request: CloudTeamTemplateCreateRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamTemplateMutationResponse> {
    assertCiphertextEnvelope(request.payload);
    return this.mutate({
      action: "template.create",
      auditAction: "team_template.created",
      context,
      operationId: "teamTemplates.create",
      principal,
      projectId,
      requestHash: hashCanonicalJson({ projectId, request, teamId }),
      responseSchema: CloudTeamTemplateMutationResponseSchema,
      responseStatus: 201,
      resourceId: request.templateId,
      resourceType: "team_template",
      teamId,
      execute: async (transaction, scope, now) => {
        await this.requireWriteEnvelope(
          transaction,
          scope,
          principal,
          request.authorDeviceId,
          request.payload,
          request.templateId,
          request.versionId,
          request.versionNumber,
          request.projectKeyVersion,
        );
        if (
          (await transaction.findTemplate(
            scope.team.tenantId,
            teamId,
            projectId,
            request.templateId,
            true,
          )) !== null
        ) {
          throw revisionConflict();
        }
        const template: CloudTeamTemplateRecord = {
          archivedAt: null,
          createdAt: now,
          createdByMembershipId: scope.actor.membershipId,
          latestVersionNumber: 1,
          projectId,
          publishedAt: null,
          publishedVersionNumber: null,
          revision: 1,
          state: "draft",
          teamId,
          templateId: request.templateId,
          tenantId: scope.team.tenantId,
          updatedAt: now,
        };
        const version = createVersionRecord({
          authorAccountId: scope.actor.accountId,
          authorDeviceId: request.authorDeviceId,
          authorMembershipId: scope.actor.membershipId,
          clonedFromTemplateId: null,
          clonedFromVersionId: null,
          now,
          payload: request.payload,
        });
        await transaction.insertTemplate(template);
        await transaction.insertVersion(version);
        return {
          audit: {
            action: "team_template.created",
            redactedDiff: {
              projectKeyVersion: version.projectKeyVersion,
              state: template.state,
              versionNumber: version.versionNumber,
            },
            resourceId: template.templateId,
            resourceType: "team_template",
          },
          response: mutationResponse(template, version, context.requestId),
          resultResourceId: template.templateId,
        };
      },
    });
  }

  public async createVersion(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    templateId: string,
    request: CloudTeamTemplateVersionCreateRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamTemplateMutationResponse> {
    assertCiphertextEnvelope(request.payload);
    return this.mutate({
      action: "template.create",
      auditAction: "team_template.version_created",
      context,
      operationId: "teamTemplateVersions.create",
      principal,
      projectId,
      requestHash: hashCanonicalJson({ projectId, request, teamId, templateId }),
      responseSchema: CloudTeamTemplateMutationResponseSchema,
      responseStatus: 201,
      resourceId: request.versionId,
      resourceType: "team_template_version",
      teamId,
      execute: async (transaction, scope, now) => {
        const template = await this.requireTemplate(transaction, scope, templateId, true);
        if (
          template.state !== "draft" ||
          template.revision !== request.expectedRevision ||
          template.revision >= Number.MAX_SAFE_INTEGER ||
          template.latestVersionNumber >= Number.MAX_SAFE_INTEGER ||
          request.versionNumber !== template.latestVersionNumber + 1
        ) {
          throw revisionConflict();
        }
        await this.requireWriteEnvelope(
          transaction,
          scope,
          principal,
          request.authorDeviceId,
          request.payload,
          templateId,
          request.versionId,
          request.versionNumber,
          request.projectKeyVersion,
        );
        if (
          (await transaction.findVersion(
            scope.team.tenantId,
            teamId,
            projectId,
            templateId,
            request.versionId,
          )) !== null
        ) {
          throw revisionConflict();
        }
        const version = createVersionRecord({
          authorAccountId: scope.actor.accountId,
          authorDeviceId: request.authorDeviceId,
          authorMembershipId: scope.actor.membershipId,
          clonedFromTemplateId: null,
          clonedFromVersionId: null,
          now,
          payload: request.payload,
        });
        const updated: CloudTeamTemplateRecord = {
          ...template,
          latestVersionNumber: request.versionNumber,
          revision: template.revision + 1,
          updatedAt: now,
        };
        await transaction.insertVersion(version);
        if (!(await transaction.updateTemplateCas(updated, request.expectedRevision))) {
          throw revisionConflict();
        }
        return {
          audit: {
            action: "team_template.version_created",
            redactedDiff: {
              projectKeyVersion: version.projectKeyVersion,
              revision: updated.revision,
              versionNumber: version.versionNumber,
            },
            resourceId: version.versionId,
            resourceType: "team_template_version",
          },
          response: mutationResponse(updated, version, context.requestId),
          resultResourceId: version.versionId,
        };
      },
    });
  }

  public async cloneTemplate(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    sourceTemplateId: string,
    request: CloudTeamTemplateCloneRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamTemplateMutationResponse> {
    assertCiphertextEnvelope(request.payload);
    return this.mutate({
      action: "template.clone",
      auditAction: "team_template.cloned",
      context,
      operationId: "teamTemplates.clone",
      principal,
      projectId,
      requestHash: hashCanonicalJson({ projectId, request, sourceTemplateId, teamId }),
      responseSchema: CloudTeamTemplateMutationResponseSchema,
      responseStatus: 201,
      resourceId: request.targetTemplateId,
      resourceType: "team_template",
      teamId,
      execute: async (transaction, scope, now) => {
        const source = await this.requireTemplate(transaction, scope, sourceTemplateId, true);
        if (
          source.state !== "published" ||
          source.revision !== request.expectedSourceRevision ||
          source.publishedVersionNumber === null
        ) {
          throw revisionConflict();
        }
        const sourceVersion = await transaction.findVersion(
          scope.team.tenantId,
          teamId,
          projectId,
          sourceTemplateId,
          request.sourceVersionId,
        );
        if (sourceVersion?.versionNumber !== source.publishedVersionNumber) {
          throw revisionConflict();
        }
        if (
          (await transaction.findTemplate(
            scope.team.tenantId,
            teamId,
            projectId,
            request.targetTemplateId,
            true,
          )) !== null
        ) {
          throw revisionConflict();
        }
        await this.requireWriteEnvelope(
          transaction,
          scope,
          principal,
          request.authorDeviceId,
          request.payload,
          request.targetTemplateId,
          request.versionId,
          request.versionNumber,
          request.projectKeyVersion,
        );
        const target: CloudTeamTemplateRecord = {
          archivedAt: null,
          createdAt: now,
          createdByMembershipId: scope.actor.membershipId,
          latestVersionNumber: 1,
          projectId,
          publishedAt: null,
          publishedVersionNumber: null,
          revision: 1,
          state: "draft",
          teamId,
          templateId: request.targetTemplateId,
          tenantId: scope.team.tenantId,
          updatedAt: now,
        };
        const targetVersion = createVersionRecord({
          authorAccountId: scope.actor.accountId,
          authorDeviceId: request.authorDeviceId,
          authorMembershipId: scope.actor.membershipId,
          clonedFromTemplateId: sourceTemplateId,
          clonedFromVersionId: sourceVersion.versionId,
          now,
          payload: request.payload,
        });
        await transaction.insertTemplate(target);
        await transaction.insertVersion(targetVersion);
        return {
          audit: {
            action: "team_template.cloned",
            redactedDiff: {
              sourceTemplateId,
              sourceVersionId: sourceVersion.versionId,
              targetVersionNumber: targetVersion.versionNumber,
            },
            resourceId: target.templateId,
            resourceType: "team_template",
          },
          response: mutationResponse(target, targetVersion, context.requestId),
          resultResourceId: target.templateId,
        };
      },
    });
  }

  public publishTemplate(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    templateId: string,
    request: CloudTeamTemplatePublishRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamTemplateResponse> {
    return this.mutate({
      action: "template.publish",
      auditAction: "team_template.published",
      context,
      operationId: "teamTemplates.publish",
      principal,
      projectId,
      requestHash: hashCanonicalJson({ projectId, request, teamId, templateId }),
      responseSchema: CloudTeamTemplateResponseSchema,
      responseStatus: 200,
      resourceId: templateId,
      resourceType: "team_template",
      teamId,
      execute: async (transaction, scope, now) => {
        const template = await this.requireTemplate(transaction, scope, templateId, true);
        const version = await transaction.findVersion(
          scope.team.tenantId,
          teamId,
          projectId,
          templateId,
          request.versionId,
        );
        if (
          template.state !== "draft" ||
          template.revision !== request.expectedRevision ||
          template.revision >= Number.MAX_SAFE_INTEGER ||
          version?.versionNumber !== template.latestVersionNumber
        ) {
          throw revisionConflict();
        }
        const updated: CloudTeamTemplateRecord = {
          ...template,
          publishedAt: now,
          publishedVersionNumber: version.versionNumber,
          revision: template.revision + 1,
          state: "published",
          updatedAt: now,
        };
        if (!(await transaction.updateTemplateCas(updated, request.expectedRevision))) {
          throw revisionConflict();
        }
        return {
          audit: {
            action: "team_template.published",
            redactedDiff: {
              revision: updated.revision,
              state: updated.state,
              versionNumber: version.versionNumber,
            },
            resourceId: templateId,
            resourceType: "team_template",
          },
          response: templateResponse(updated, context.requestId),
          resultResourceId: templateId,
        };
      },
    });
  }

  public archiveTemplate(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    templateId: string,
    request: CloudTeamTemplateArchiveRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamTemplateResponse> {
    return this.mutate({
      action: "template.archive",
      auditAction: "team_template.archived",
      context,
      operationId: "teamTemplates.archive",
      principal,
      projectId,
      requestHash: hashCanonicalJson({ projectId, request, teamId, templateId }),
      responseSchema: CloudTeamTemplateResponseSchema,
      responseStatus: 200,
      resourceId: templateId,
      resourceType: "team_template",
      teamId,
      execute: async (transaction, scope, now) => {
        const template = await this.requireTemplate(transaction, scope, templateId, true);
        if (
          template.state === "archived" ||
          template.revision !== request.expectedRevision ||
          template.revision >= Number.MAX_SAFE_INTEGER
        ) {
          throw revisionConflict();
        }
        const updated: CloudTeamTemplateRecord = {
          ...template,
          archivedAt: now,
          revision: template.revision + 1,
          state: "archived",
          updatedAt: now,
        };
        if (!(await transaction.updateTemplateCas(updated, request.expectedRevision))) {
          throw revisionConflict();
        }
        return {
          audit: {
            action: "team_template.archived",
            redactedDiff: {
              revision: updated.revision,
              state: updated.state,
            },
            resourceId: templateId,
            resourceType: "team_template",
          },
          response: templateResponse(updated, context.requestId),
          resultResourceId: templateId,
        };
      },
    });
  }

  public recordApplication(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    templateId: string,
    request: CloudTeamTemplateApplyRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamTemplateApplicationResponse> {
    return this.mutate({
      action: "template.apply",
      auditAction: "team_template.application_recorded",
      context,
      operationId: "teamTemplateApplications.record",
      principal,
      projectId,
      requestHash: hashCanonicalJson({ projectId, request, teamId, templateId }),
      responseSchema: CloudTeamTemplateApplicationResponseSchema,
      responseStatus: 201,
      resourceId: request.applicationId,
      resourceType: "team_template_application",
      teamId,
      execute: async (transaction, scope, now) => {
        const template = await this.requireTemplate(transaction, scope, templateId, true);
        const version = await transaction.findVersion(
          scope.team.tenantId,
          teamId,
          projectId,
          templateId,
          request.versionId,
        );
        const publishedRevisionMatches =
          template.state === "published" && template.revision === request.expectedRevision;
        const archivedRecoveryMatches =
          template.state === "archived" &&
          request.expectedRevision < Number.MAX_SAFE_INTEGER &&
          template.revision === request.expectedRevision + 1;
        if (
          (!publishedRevisionMatches && !archivedRecoveryMatches) ||
          template.publishedVersionNumber === null ||
          version?.versionNumber !== template.publishedVersionNumber
        ) {
          throw revisionConflict();
        }
        if (
          (await transaction.findApplication(
            scope.team.tenantId,
            teamId,
            projectId,
            request.applicationId,
          )) !== null
        ) {
          throw revisionConflict();
        }
        const application: CloudTeamTemplateApplicationRecord = {
          applicationId: request.applicationId,
          appliedAt: now,
          appliedByAccountId: scope.actor.accountId,
          appliedByMembershipId: scope.actor.membershipId,
          projectId,
          teamId,
          templateId,
          tenantId: scope.team.tenantId,
          versionId: version.versionId,
        };
        await transaction.insertApplication(application);
        const response = applicationResponse(application, context.requestId);
        return {
          audit: {
            action: "team_template.application_recorded",
            redactedDiff: {
              effect: response.effect,
              versionId: version.versionId,
              versionNumber: version.versionNumber,
            },
            resourceId: application.applicationId,
            resourceType: "team_template_application",
          },
          response,
          resultResourceId: application.applicationId,
        };
      },
    });
  }

  public async listTemplates(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudTeamTemplateListResponse> {
    const pageSize = requirePageSize(limit);
    const anchor = this.decodeCursor("team_templates", cursor);
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      const scope = await this.requireScope(transaction, principal, teamId, projectId, false);
      requireAllowed(scope, "template.read");
      const records = await transaction.listTemplates(
        scope.team.tenantId,
        teamId,
        projectId,
        pageSize + 1,
        anchor,
      );
      const page = records.slice(0, pageSize);
      const continuationRecord = records.length > pageSize ? page.at(-1) : undefined;
      if (records.length > pageSize && continuationRecord === undefined) {
        throw new Error("A template page with a continuation must not be empty.");
      }
      return CloudTeamTemplateListResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        templates: page.map(toTemplateSummary),
        nextCursor:
          continuationRecord === undefined
            ? null
            : this.pageCursorCodec.encode("team_templates", templateAnchor(continuationRecord)),
      });
    });
  }

  public async getTemplate(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    templateId: string,
    context: CloudReadContext,
  ): Promise<CloudTeamTemplateResponse> {
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      const scope = await this.requireScope(transaction, principal, teamId, projectId, false);
      requireAllowed(scope, "template.read");
      const template = await this.requireTemplate(transaction, scope, templateId, false);
      return templateResponse(template, context.requestId);
    });
  }

  public async listVersions(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    templateId: string,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudTeamTemplateVersionListResponse> {
    const pageSize = requirePageSize(limit);
    const anchor = this.decodeCursor("team_template_versions", cursor);
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      const scope = await this.requireScope(transaction, principal, teamId, projectId, false);
      requireAllowed(scope, "template.read");
      await this.requireTemplate(transaction, scope, templateId, false);
      const records = await transaction.listVersions(
        scope.team.tenantId,
        teamId,
        projectId,
        templateId,
        pageSize + 1,
        anchor,
      );
      const page = records.slice(0, pageSize);
      const continuationRecord = records.length > pageSize ? page.at(-1) : undefined;
      if (records.length > pageSize && continuationRecord === undefined) {
        throw new Error("A template-version page with a continuation must not be empty.");
      }
      return CloudTeamTemplateVersionListResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        versions: page.map(toVersionSummary),
        nextCursor:
          continuationRecord === undefined
            ? null
            : this.pageCursorCodec.encode(
                "team_template_versions",
                versionAnchor(continuationRecord),
              ),
      });
    });
  }

  public async getVersion(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    templateId: string,
    versionId: string,
    context: CloudReadContext,
  ): Promise<CloudTeamTemplateVersionResponse> {
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      const scope = await this.requireScope(transaction, principal, teamId, projectId, false);
      requireAllowed(scope, "template.read");
      await this.requireTemplate(transaction, scope, templateId, false);
      const version = await transaction.findVersion(
        scope.team.tenantId,
        teamId,
        projectId,
        templateId,
        versionId,
      );
      if (version === null) {
        throw resourceNotFound();
      }
      return CloudTeamTemplateVersionResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        version: toVersion(version),
      });
    });
  }

  private async mutate<Output>(options: {
    readonly action: AccessAction;
    readonly auditAction: string;
    readonly context: CloudMutationContext;
    readonly execute: (
      transaction: CloudTeamTemplateTransaction,
      scope: TeamTemplateScope,
      now: Date,
    ) => Promise<MutationResult<Output>>;
    readonly operationId: CloudApiOperationId;
    readonly principal: CloudPrincipal;
    readonly projectId: string;
    readonly requestHash: string;
    readonly resourceId: string;
    readonly resourceType: CloudTeamAuditEventRecord["resourceType"];
    readonly responseSchema: { readonly parse: (value: unknown) => Output };
    readonly responseStatus: number;
    readonly teamId: string;
  }): Promise<Output> {
    const now = this.now();
    const outcome = await this.store.transaction<MutationOutcome<Output>>(async (transaction) => {
      await this.requirePrincipal(transaction, options.principal, now);
      const scope = await this.requireScope(
        transaction,
        options.principal,
        options.teamId,
        options.projectId,
        true,
      );
      const decision = authorize(scope, options.action);
      if (!decision.allowed) {
        await transaction.insertAuditEvent(
          this.audit({
            action: options.auditAction,
            context: options.context,
            now,
            reason: decision.reason,
            redactedDiff: {},
            resourceId: options.resourceId,
            resourceType: options.resourceType,
            result: "denied",
            scope,
          }),
        );
        return { error: accessForbidden() };
      }
      const replay = await this.findIdempotency(
        transaction,
        options.operationId,
        options.principal.accountId,
        options.context,
        options.requestHash,
        now,
      );
      if (replay !== null) {
        return {
          value: replaySnapshot(options.responseSchema, replay, options.context.requestId),
        };
      }
      const result = await options.execute(transaction, scope, now);
      await transaction.insertAuditEvent(
        this.audit({
          ...result.audit,
          context: options.context,
          now,
          reason: "allowed",
          result: "allowed",
          scope,
        }),
      );
      await this.insertIdempotency(transaction, {
        actorAccountId: options.principal.accountId,
        context: options.context,
        now,
        operationId: options.operationId,
        requestHash: options.requestHash,
        response: result.response,
        responseStatus: options.responseStatus,
        resultResourceId: result.resultResourceId,
      });
      return { value: result.response };
    });
    return unwrapMutation(outcome);
  }

  private async requirePrincipal(
    transaction: CloudTeamTemplateTransaction,
    principal: CloudPrincipal,
    now: Date,
  ): Promise<void> {
    await transaction.setPrincipal(principal.accountId, principal.deviceId);
    if (!(await transaction.assertPrincipalActive(principal, now))) {
      throw sessionExpired();
    }
  }

  private async requireScope(
    transaction: CloudTeamTemplateTransaction,
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    forUpdate: boolean,
  ): Promise<TeamTemplateScope> {
    await transaction.clearTeamScope();
    const discovered = await transaction.findActiveMembershipForAccount(
      principal.accountId,
      teamId,
    );
    if (discovered === null) {
      throw resourceNotFound();
    }
    await transaction.setTeamScope(discovered.tenantId, teamId);
    const team = await transaction.findTeam(discovered.tenantId, teamId, forUpdate);
    const actor = await transaction.findMembership(
      discovered.tenantId,
      teamId,
      discovered.membershipId,
      forUpdate,
    );
    const project = await transaction.findProject(discovered.tenantId, projectId, forUpdate);
    const assignment = await transaction.findAssignment(
      discovered.tenantId,
      teamId,
      projectId,
      discovered.membershipId,
      forUpdate,
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

  private async requireTemplate(
    transaction: CloudTeamTemplateTransaction,
    scope: TeamTemplateScope,
    templateId: string,
    forUpdate: boolean,
  ): Promise<CloudTeamTemplateRecord> {
    const template = await transaction.findTemplate(
      scope.team.tenantId,
      scope.team.teamId,
      scope.project.projectId,
      templateId,
      forUpdate,
    );
    if (template === null) {
      throw resourceNotFound();
    }
    return template;
  }

  private async requireWriteEnvelope(
    transaction: CloudTeamTemplateTransaction,
    scope: TeamTemplateScope,
    principal: CloudPrincipal,
    authorDeviceId: string,
    payload: CloudTeamTemplateVersionRecord["payload"],
    templateId: string,
    versionId: string,
    versionNumber: number,
    projectKeyVersion: number,
  ): Promise<void> {
    const aad = payload.aad;
    if (
      aad.tenantId !== scope.team.tenantId ||
      aad.teamId !== scope.team.teamId ||
      aad.projectId !== scope.project.projectId ||
      aad.templateId !== templateId ||
      aad.versionId !== versionId ||
      aad.versionNumber !== versionNumber ||
      aad.projectKeyVersion !== projectKeyVersion ||
      authorDeviceId !== principal.deviceId
    ) {
      throw invalidCiphertext();
    }
    const device = await transaction.findDevice(authorDeviceId, true);
    if (
      device?.state !== "trusted" ||
      device.accountId !== scope.actor.accountId ||
      device.deviceId !== principal.deviceId
    ) {
      throw accessForbidden();
    }
    const key = await transaction.findProjectKeyVersion(
      scope.team.tenantId,
      scope.project.projectId,
      projectKeyVersion,
      true,
    );
    if (key?.state !== "active" || scope.project.currentKeyVersion !== projectKeyVersion) {
      throw revisionConflict();
    }
  }

  private async findIdempotency(
    transaction: CloudTeamTemplateTransaction,
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
      existing.resultKind !== "team_template"
    ) {
      throw idempotencyConflict();
    }
    return existing;
  }

  private insertIdempotency(
    transaction: CloudTeamTemplateTransaction,
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
      resultKind: "team_template",
      resultResourceId: options.resultResourceId,
      scopeHashSha256: createIdempotencyScopeHash({
        actorAccountId: options.actorAccountId,
        idempotencyKey: options.context.idempotencyKey,
        operationId: options.operationId,
      }),
    });
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
    readonly scope: TeamTemplateScope;
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
    kind: Extract<CloudPageCursorKind, "team_template_versions" | "team_templates">,
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
      throw new Error("The team-template clock returned an invalid date.");
    }
    return new Date(value.getTime());
  }
}

function authorize(scope: TeamTemplateScope, action: AccessAction): AccessDecision {
  return authorizeTeamAction(toAccessMembership(scope.actor, scope.project.projectId), {
    action,
    projectId: scope.project.projectId,
    resourceState: "active",
    resourceType: "project_template",
    teamId: scope.team.teamId,
    tenantId: scope.team.tenantId,
  });
}

function requireAllowed(scope: TeamTemplateScope, action: AccessAction): void {
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

function createVersionRecord(options: {
  readonly authorAccountId: string;
  readonly authorDeviceId: string;
  readonly authorMembershipId: string;
  readonly clonedFromTemplateId: string | null;
  readonly clonedFromVersionId: string | null;
  readonly now: Date;
  readonly payload: CloudTeamTemplateVersionRecord["payload"];
}): CloudTeamTemplateVersionRecord {
  const aad = options.payload.aad;
  return {
    authorAccountId: options.authorAccountId,
    authorDeviceId: options.authorDeviceId,
    authorMembershipId: options.authorMembershipId,
    clonedFromTemplateId: options.clonedFromTemplateId,
    clonedFromVersionId: options.clonedFromVersionId,
    createdAt: options.now,
    payload: options.payload,
    projectId: aad.projectId,
    projectKeyVersion: aad.projectKeyVersion,
    teamId: aad.teamId,
    templateId: aad.templateId,
    tenantId: aad.tenantId,
    versionId: aad.versionId,
    versionNumber: aad.versionNumber,
  };
}

function templateResponse(
  record: CloudTeamTemplateRecord,
  requestId: string,
): CloudTeamTemplateResponse {
  return CloudTeamTemplateResponseSchema.parse({
    requestId,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    template: toTemplateSummary(record),
  });
}

function mutationResponse(
  template: CloudTeamTemplateRecord,
  version: CloudTeamTemplateVersionRecord,
  requestId: string,
): CloudTeamTemplateMutationResponse {
  return CloudTeamTemplateMutationResponseSchema.parse({
    requestId,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    template: toTemplateSummary(template),
    version: toVersionSummary(version),
  });
}

function applicationResponse(
  record: CloudTeamTemplateApplicationRecord,
  requestId: string,
): CloudTeamTemplateApplicationResponse {
  return CloudTeamTemplateApplicationResponseSchema.parse({
    applicationId: record.applicationId,
    appliedAt: record.appliedAt.toISOString(),
    appliedByMembershipId: record.appliedByMembershipId,
    effect: "metadata_only_no_server_content_mutation",
    projectId: record.projectId,
    requestId,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    teamId: record.teamId,
    templateId: record.templateId,
    tenantId: record.tenantId,
    versionId: record.versionId,
  });
}

function toTemplateSummary(record: CloudTeamTemplateRecord): CloudTeamTemplateSummary {
  return {
    archivedAt: record.archivedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    createdByMembershipId: record.createdByMembershipId,
    latestVersionNumber: record.latestVersionNumber,
    projectId: record.projectId,
    publishedAt: record.publishedAt?.toISOString() ?? null,
    publishedVersionNumber: record.publishedVersionNumber,
    revision: record.revision,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    state: record.state,
    teamId: record.teamId,
    templateId: record.templateId,
    tenantId: record.tenantId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toVersionSummary(record: CloudTeamTemplateVersionRecord): CloudTeamTemplateVersionSummary {
  return {
    authorDeviceId: record.authorDeviceId,
    authorMembershipId: record.authorMembershipId,
    clonedFromTemplateId: record.clonedFromTemplateId,
    clonedFromVersionId: record.clonedFromVersionId,
    createdAt: record.createdAt.toISOString(),
    projectId: record.projectId,
    projectKeyVersion: record.projectKeyVersion,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    teamId: record.teamId,
    templateId: record.templateId,
    tenantId: record.tenantId,
    versionId: record.versionId,
    versionNumber: record.versionNumber,
  };
}

function toVersion(record: CloudTeamTemplateVersionRecord): CloudTeamTemplateVersion {
  return {
    ...toVersionSummary(record),
    payload: record.payload,
  };
}

function assertCiphertextEnvelope(envelope: CloudTeamTemplateVersionRecord["payload"]): void {
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
    record.resultKind !== "team_template" ||
    typeof record.responseSnapshot !== "object" ||
    record.responseSnapshot === null ||
    hashCanonicalJson(record.responseSnapshot) !== record.resultDigestSha256
  ) {
    throw new Error("The team-template idempotency record is internally inconsistent.");
  }
  return schema.parse({ ...record.responseSnapshot, requestId });
}

function requirePageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_PAGE_SIZE) {
    throw validationFailed("The requested team-template page size is invalid.");
  }
  return value;
}

function templateAnchor(record: CloudTeamTemplateRecord): CloudPageAnchor {
  return { createdAt: record.createdAt, id: record.templateId };
}

function versionAnchor(record: CloudTeamTemplateVersionRecord): CloudPageAnchor {
  return { createdAt: record.createdAt, id: record.versionId };
}

function unwrapMutation<Output>(outcome: MutationOutcome<Output>): Output {
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
