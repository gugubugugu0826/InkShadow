import {
  authorizeProjectBusinessAccess,
  evaluateProjectKeyEnvelopeEligibility,
  type ProjectBusinessAccessDecision,
  type TeamMembership,
} from "@inkshadow/access-core";
import {
  CloudTeamProjectCurrentKeyResponseSchema,
  CloudTeamProjectKeyEligibleRecipientListResponseSchema,
  CloudTeamProjectKeyEnvelopeResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudApiOperationId,
  type CloudTeamProjectCurrentKeyResponse,
  type CloudTeamProjectKeyEligibleRecipient,
  type CloudTeamProjectKeyEligibleRecipientListResponse,
  type CloudTeamProjectKeyEnvelope,
  type CloudTeamProjectKeyEnvelopePublishRequest,
  type CloudTeamProjectKeyEnvelopeResponse,
} from "@inkshadow/contracts";

import type { CloudProjectRecord } from "../domain/project-records.js";
import type { CloudIdempotencyRecord, RegisteredDeviceRecord } from "../domain/records.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamMembershipRecord,
  CloudTeamProjectKeyEnvelopeRecord,
  CloudTeamProjectKeyVersionRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type {
  CloudTeamProjectKeyRecipientCandidate,
  CloudTeamStore,
  CloudTeamTransaction,
} from "../repository/team-store.js";
import {
  createIdempotencyScopeHash,
  hashCanonicalJson,
  hashUtf8,
} from "../security/canonical-hash.js";
import type { UuidV7Factory } from "../security/uuid-v7.js";
import {
  accessForbidden,
  idempotencyConflict,
  resourceNotFound,
  revisionConflict,
  sessionExpired,
  validationFailed,
} from "./errors.js";
import type { CloudMutationContext, CloudPrincipal, CloudReadContext } from "./identity-service.js";

const DEFAULT_IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_ELIGIBLE_RECIPIENTS = 10_000;

export interface CloudTeamProjectKeyServiceOptions {
  readonly clock?: () => Date;
  readonly idempotencyLifetimeMs?: number;
  readonly store: CloudTeamStore;
  readonly uuid: UuidV7Factory;
}

interface TeamScope {
  readonly actor: CloudTeamMembershipRecord;
  readonly team: CloudTeamRecord;
}

interface KeyManagementScope extends TeamScope {
  readonly actorBusinessAccess: ProjectBusinessAccessDecision;
  readonly project: CloudProjectRecord;
  readonly projectKey: CloudTeamProjectKeyVersionRecord;
  readonly senderDevice: RegisteredDeviceRecord;
}

export class CloudTeamProjectKeyService {
  private readonly clock: () => Date;
  private readonly idempotencyLifetimeMs: number;
  private readonly store: CloudTeamStore;
  private readonly uuid: UuidV7Factory;

  public constructor(options: CloudTeamProjectKeyServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.idempotencyLifetimeMs = options.idempotencyLifetimeMs ?? DEFAULT_IDEMPOTENCY_LIFETIME_MS;
    this.store = options.store;
    this.uuid = options.uuid;
    if (!Number.isSafeInteger(this.idempotencyLifetimeMs) || this.idempotencyLifetimeMs <= 0) {
      throw new Error("The team project-key idempotency lifetime must be a positive integer.");
    }
  }

  public getCurrentKeyMetadata(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    context: CloudReadContext,
  ): Promise<CloudTeamProjectCurrentKeyResponse> {
    return this.store.transaction(async (transaction) => {
      const now = this.now();
      await this.requirePrincipal(transaction, principal, now);
      const scope = await this.requireTeamScope(transaction, principal, teamId, false);
      const project = await transaction.findProject(scope.team.tenantId, projectId);
      const assignment = await transaction.findAssignment(
        scope.team.tenantId,
        teamId,
        projectId,
        scope.actor.membershipId,
      );
      const currentDevice = await transaction.findDevice(principal.deviceId);
      if (project === null || assignment === null || currentDevice === null) {
        throw resourceNotFound();
      }

      const businessAccess = recipientBusinessAccess(
        scope.actor,
        assignment,
        project,
        "project.read",
      );
      if (!businessAccess.allowed || project.state !== "active") {
        throw resourceNotFound();
      }
      if (
        currentDevice.accountId !== principal.accountId ||
        currentDevice.state !== "trusted" ||
        currentDevice.revokedAt !== null
      ) {
        throw accessForbidden();
      }

      const currentKey = await transaction.findCurrentProjectKeyVersion(
        scope.team.tenantId,
        projectId,
      );
      if (currentKey?.state !== "active" || project.currentKeyVersion !== currentKey.keyVersion) {
        throw resourceNotFound();
      }
      const currentDeviceEnvelopeAvailable =
        await transaction.hasCurrentPrincipalTeamProjectKeyEnvelope(
          scope.team.tenantId,
          teamId,
          projectId,
          currentKey.keyVersion,
        );
      return CloudTeamProjectCurrentKeyResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        teamId,
        projectId,
        keyVersion: currentKey.keyVersion,
        state: currentKey.state,
        serverRevision: currentKey.serverRevision,
        updatedAt: currentKey.updatedAt.toISOString(),
        currentDeviceEnvelopeAvailable,
      });
    });
  }

  public listEligibleRecipients(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    keyVersion: number,
    context: CloudReadContext,
  ): Promise<CloudTeamProjectKeyEligibleRecipientListResponse> {
    requireKeyVersion(keyVersion);
    return this.store.transaction(async (transaction) => {
      const now = this.now();
      await this.requirePrincipal(transaction, principal, now);
      const scope = await this.requireKeyManagementScope(
        transaction,
        principal,
        teamId,
        projectId,
        keyVersion,
        false,
      );
      const candidates = await transaction.listActiveTeamProjectKeyRecipientCandidates(
        scope.team.tenantId,
        teamId,
        projectId,
        MAXIMUM_ELIGIBLE_RECIPIENTS + 1,
      );
      if (candidates.length > MAXIMUM_ELIGIBLE_RECIPIENTS) {
        throw validationFailed("The project has too many eligible team recipient devices.");
      }
      const recipients = candidates
        .filter((candidate) => this.isEligibleRecipient(scope, candidate))
        .map((candidate) => toEligibleRecipient(candidate, teamId, projectId, keyVersion));
      return CloudTeamProjectKeyEligibleRecipientListResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        teamId,
        projectId,
        keyVersion,
        recipients,
      });
    });
  }

  public publishEnvelope(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    keyVersion: number,
    request: CloudTeamProjectKeyEnvelopePublishRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamProjectKeyEnvelopeResponse> {
    requireKeyVersion(keyVersion);
    assertRequestScope(request, teamId, projectId, keyVersion, principal.deviceId);
    const now = this.now();
    const requestHash = hashCanonicalJson(request);
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, now);
      const scope = await this.requireKeyManagementScope(
        transaction,
        principal,
        teamId,
        projectId,
        keyVersion,
        true,
      );
      const existingIdempotency = await this.findIdempotency(
        transaction,
        "teamProjectKeyEnvelopes.publish",
        principal.accountId,
        context,
        requestHash,
        now,
      );

      const recipientMembership = await transaction.findMembership(
        scope.team.tenantId,
        teamId,
        request.membershipId,
        true,
      );
      const assignment = await transaction.findAssignment(
        scope.team.tenantId,
        teamId,
        projectId,
        request.membershipId,
        true,
      );
      const recipientDevice = await transaction.findDevice(request.recipientDeviceId, true);
      if (recipientMembership === null || assignment === null || recipientDevice === null) {
        throw revisionConflict();
      }
      this.requireRecipientEligibility(
        scope,
        request,
        recipientMembership,
        assignment,
        recipientDevice,
      );

      if (existingIdempotency !== null) {
        const persisted = await transaction.findTeamProjectKeyEnvelopeById(
          scope.team.tenantId,
          teamId,
          request.envelopeId,
        );
        if (
          persisted?.invalidatedAt !== null ||
          persisted.recipientDeviceId !== request.recipientDeviceId ||
          persisted.membershipRevision !== request.membershipRevision ||
          persisted.assignmentRevision !== request.assignmentRevision
        ) {
          throw revisionConflict();
        }
        return replayEnvelope(existingIdempotency, context.requestId);
      }

      const activeEnvelopeExists = await transaction.hasActiveTeamProjectKeyEnvelope(
        scope.team.tenantId,
        teamId,
        projectId,
        keyVersion,
        request.recipientDeviceId,
      );
      if (activeEnvelopeExists) {
        throw revisionConflict();
      }

      const record: CloudTeamProjectKeyEnvelopeRecord = {
        algorithm: request.algorithm,
        assignmentId: request.assignmentId,
        assignmentRevision: request.assignmentRevision,
        ciphertext: request.ciphertext,
        createdAt: now,
        encapsulatedKey: request.encapsulatedKey,
        envelopeId: request.envelopeId,
        invalidatedAt: null,
        invalidationReason: null,
        keyVersion,
        membershipId: request.membershipId,
        membershipRevision: request.membershipRevision,
        projectId,
        recipientAccountId: recipientMembership.accountId,
        recipientDeviceId: request.recipientDeviceId,
        recipientDeviceRevision: recipientDevice.revision,
        recipientPublicKey: request.recipientPublicKey,
        recipientPublicKeyFingerprint: request.recipientPublicKeyFingerprint,
        senderAccountId: principal.accountId,
        senderDeviceId: principal.deviceId,
        senderDeviceRevision: scope.senderDevice.revision,
        senderMembershipId: scope.actor.membershipId,
        senderMembershipRevision: scope.actor.revision,
        senderPublicKey: request.senderPublicKey,
        senderPublicKeyFingerprint: request.senderPublicKeyFingerprint,
        serverRevision: 1,
        teamId,
        tenantId: scope.team.tenantId,
      };
      await transaction.insertTeamProjectKeyEnvelope(record);
      const response = CloudTeamProjectKeyEnvelopeResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        envelope: toCloudEnvelope(record),
      });
      await transaction.insertAuditEvent({
        action: "team_project_key_envelope.published",
        actorAccountId: principal.accountId,
        actorMembershipId: scope.actor.membershipId,
        createdAt: now,
        eventId: this.uuid(),
        reason: "allowed",
        redactedDiff: {
          assignmentId: record.assignmentId,
          assignmentRevision: record.assignmentRevision,
          keyVersion: record.keyVersion,
          membershipId: record.membershipId,
          membershipRevision: record.membershipRevision,
          recipientDeviceId: record.recipientDeviceId,
        },
        requestId: context.requestId,
        resourceId: record.envelopeId,
        resourceType: "project_key_envelope",
        result: "allowed",
        teamId,
        tenantId: scope.team.tenantId,
      });
      await this.insertIdempotency(transaction, {
        actorAccountId: principal.accountId,
        context,
        now,
        operationId: "teamProjectKeyEnvelopes.publish",
        requestHash,
        response,
        resultResourceId: record.envelopeId,
      });
      return response;
    });
  }

  public getCurrentDeviceEnvelope(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    keyVersion: number,
    context: CloudReadContext,
  ): Promise<CloudTeamProjectKeyEnvelopeResponse> {
    requireKeyVersion(keyVersion);
    return this.store.transaction(async (transaction) => {
      const now = this.now();
      await this.requirePrincipal(transaction, principal, now);
      const scope = await this.requireTeamScope(transaction, principal, teamId, false);
      const project = await transaction.findProject(scope.team.tenantId, projectId);
      const projectKey = await transaction.findProjectKeyVersion(
        scope.team.tenantId,
        projectId,
        keyVersion,
      );
      const assignment = await transaction.findAssignment(
        scope.team.tenantId,
        teamId,
        projectId,
        scope.actor.membershipId,
      );
      const currentDevice = await transaction.findDevice(principal.deviceId);
      const envelope = await transaction.findActiveTeamProjectKeyEnvelope(
        scope.team.tenantId,
        teamId,
        projectId,
        keyVersion,
        principal.deviceId,
      );
      if (
        project === null ||
        projectKey === null ||
        assignment === null ||
        currentDevice === null ||
        envelope === null
      ) {
        throw resourceNotFound();
      }
      const targetBusinessAccess = recipientBusinessAccess(
        scope.actor,
        assignment,
        project,
        "project.read",
      );
      const eligibility = evaluateProjectKeyEnvelopeEligibility({
        businessAccess: targetBusinessAccess,
        membership: toAccessMembership(scope.actor, [projectId]),
        projectId,
        projectKeyState: projectKey.state,
        projectState: project.state,
        recipientDevice: toEligibilityDevice(currentDevice),
        teamId,
        tenantId: scope.team.tenantId,
      });
      if (
        !eligibility.eligible ||
        envelope.membershipId !== scope.actor.membershipId ||
        envelope.membershipRevision !== scope.actor.revision ||
        envelope.assignmentId !== assignment.assignmentId ||
        envelope.assignmentRevision !== assignment.revision ||
        envelope.recipientAccountId !== principal.accountId ||
        envelope.recipientDeviceId !== principal.deviceId ||
        envelope.recipientDeviceRevision !== currentDevice.revision ||
        envelope.recipientPublicKey !== currentDevice.publicKey ||
        envelope.recipientPublicKeyFingerprint !== currentDevice.publicKeyFingerprint ||
        project.currentKeyVersion !== keyVersion
      ) {
        throw accessForbidden();
      }
      return CloudTeamProjectKeyEnvelopeResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        envelope: toCloudEnvelope(envelope),
      });
    });
  }

  private async requireKeyManagementScope(
    transaction: CloudTeamTransaction,
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    keyVersion: number,
    forUpdate: boolean,
  ): Promise<KeyManagementScope> {
    const scope = await this.requireTeamScope(transaction, principal, teamId, forUpdate);
    const project = await transaction.findProject(scope.team.tenantId, projectId, forUpdate);
    if (project === null) {
      throw resourceNotFound();
    }
    const actorProjectIds = await transaction.listActiveProjectIdsForMembership(
      scope.team.tenantId,
      teamId,
      scope.actor.membershipId,
    );
    const effectiveProjectIds =
      project.ownerAccountId === principal.accountId
        ? [...new Set([...actorProjectIds, projectId])].sort()
        : actorProjectIds;
    const actorBusinessAccess = authorizeProjectBusinessAccess(
      toAccessMembership(scope.actor, effectiveProjectIds),
      {
        action: "key.issue_envelope",
        projectId,
        resourceState: project.state,
        resourceType: "project_key_metadata",
        teamId,
        tenantId: scope.team.tenantId,
      },
    );
    if (!actorBusinessAccess.allowed) {
      throw accessForbidden();
    }
    const projectAccess = await transaction.findProjectAccess(
      scope.team.tenantId,
      projectId,
      principal.accountId,
      forUpdate,
    );
    if (projectAccess?.revokedAt !== null || !projectAccess.canManageKeys) {
      throw accessForbidden();
    }
    const projectKey = await transaction.findProjectKeyVersion(
      scope.team.tenantId,
      projectId,
      keyVersion,
      forUpdate,
    );
    if (
      projectKey?.state !== "active" ||
      project.state !== "active" ||
      project.currentKeyVersion !== keyVersion
    ) {
      throw accessForbidden();
    }
    const senderDevice = await transaction.findDevice(principal.deviceId, forUpdate);
    if (
      senderDevice?.accountId !== principal.accountId ||
      senderDevice.state !== "trusted" ||
      senderDevice.revokedAt !== null
    ) {
      throw accessForbidden();
    }
    if (
      !(await transaction.hasActivePersonalDeviceEnvelope(
        scope.team.tenantId,
        projectId,
        keyVersion,
        principal.deviceId,
      ))
    ) {
      throw accessForbidden();
    }
    return { ...scope, actorBusinessAccess, project, projectKey, senderDevice };
  }

  private async requireTeamScope(
    transaction: CloudTeamTransaction,
    principal: CloudPrincipal,
    teamId: string,
    forUpdate: boolean,
  ): Promise<TeamScope> {
    await transaction.clearTeamScope();
    const discovered = await transaction.findActiveMembershipForAccount(
      principal.accountId,
      teamId,
    );
    if (discovered === null) {
      throw resourceNotFound();
    }
    await transaction.setTeamScope(discovered.tenantId, teamId);
    const team = forUpdate
      ? await transaction.lockTeam(discovered.tenantId, teamId)
      : await transaction.findTeam(discovered.tenantId, teamId);
    const actor = await transaction.findMembership(
      discovered.tenantId,
      teamId,
      discovered.membershipId,
      forUpdate,
    );
    if (team?.state !== "active" || actor?.state !== "active") {
      throw resourceNotFound();
    }
    return { actor, team };
  }

  private isEligibleRecipient(
    scope: KeyManagementScope,
    candidate: CloudTeamProjectKeyRecipientCandidate,
  ): boolean {
    const businessAccess = recipientBusinessAccess(
      candidate.membership,
      candidate.assignment,
      scope.project,
      "project.read",
    );
    return evaluateProjectKeyEnvelopeEligibility({
      businessAccess,
      membership: toAccessMembership(candidate.membership, [scope.project.projectId]),
      projectId: scope.project.projectId,
      projectKeyState: scope.projectKey.state,
      projectState: scope.project.state,
      recipientDevice: toEligibilityDevice(candidate.device),
      teamId: scope.team.teamId,
      tenantId: scope.team.tenantId,
    }).eligible;
  }

  private requireRecipientEligibility(
    scope: KeyManagementScope,
    request: CloudTeamProjectKeyEnvelopePublishRequest,
    membership: CloudTeamMembershipRecord,
    assignment: CloudProjectAssignmentRecord,
    device: RegisteredDeviceRecord,
  ): void {
    if (
      membership.state !== "active" ||
      assignment.state !== "active" ||
      membership.revision !== request.membershipRevision ||
      assignment.assignmentId !== request.assignmentId ||
      assignment.revision !== request.assignmentRevision
    ) {
      throw revisionConflict();
    }
    const businessAccess = recipientBusinessAccess(
      membership,
      assignment,
      scope.project,
      "project.read",
    );
    const eligibility = evaluateProjectKeyEnvelopeEligibility({
      businessAccess,
      membership: toAccessMembership(membership, [scope.project.projectId]),
      projectId: scope.project.projectId,
      projectKeyState: scope.projectKey.state,
      projectState: scope.project.state,
      recipientDevice: toEligibilityDevice(device),
      teamId: scope.team.teamId,
      tenantId: scope.team.tenantId,
    });
    if (
      !eligibility.eligible ||
      device.deviceId !== request.recipientDeviceId ||
      device.publicKey !== request.recipientPublicKey ||
      device.publicKeyFingerprint !== request.recipientPublicKeyFingerprint ||
      scope.senderDevice.publicKey !== request.senderPublicKey ||
      scope.senderDevice.publicKeyFingerprint !== request.senderPublicKeyFingerprint
    ) {
      throw accessForbidden();
    }
  }

  private async requirePrincipal(
    transaction: CloudTeamTransaction,
    principal: CloudPrincipal,
    now: Date,
  ): Promise<void> {
    await transaction.setPrincipal(principal.accountId, principal.deviceId);
    if (!(await transaction.assertPrincipalActive(principal, now))) {
      throw sessionExpired();
    }
  }

  private async findIdempotency(
    transaction: CloudTeamTransaction,
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
      existing.expiresAt.getTime() <= now.getTime()
    ) {
      throw idempotencyConflict();
    }
    return existing;
  }

  private insertIdempotency(
    transaction: CloudTeamTransaction,
    options: {
      readonly actorAccountId: string;
      readonly context: CloudMutationContext;
      readonly now: Date;
      readonly operationId: CloudApiOperationId;
      readonly requestHash: string;
      readonly response: CloudTeamProjectKeyEnvelopeResponse;
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
      responseStatus: 201,
      resultDigestSha256: hashCanonicalJson(options.response),
      resultKind: "team_project_key_envelope",
      resultResourceId: options.resultResourceId,
      scopeHashSha256: createIdempotencyScopeHash({
        actorAccountId: options.actorAccountId,
        idempotencyKey: options.context.idempotencyKey,
        operationId: options.operationId,
      }),
    });
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The team project-key service clock returned an invalid timestamp.");
    }
    return new Date(value);
  }
}

function recipientBusinessAccess(
  membership: CloudTeamMembershipRecord,
  assignment: CloudProjectAssignmentRecord,
  project: CloudProjectRecord,
  action: "project.read",
): ProjectBusinessAccessDecision {
  const projectIds =
    assignment.state === "active" &&
    assignment.tenantId === membership.tenantId &&
    assignment.teamId === membership.teamId &&
    assignment.membershipId === membership.membershipId &&
    assignment.projectId === project.projectId
      ? [project.projectId]
      : [];
  return authorizeProjectBusinessAccess(toAccessMembership(membership, projectIds), {
    action,
    projectId: project.projectId,
    resourceState: project.state,
    resourceType: "project_content",
    teamId: membership.teamId,
    tenantId: membership.tenantId,
  });
}

function toAccessMembership(
  record: CloudTeamMembershipRecord,
  projectIds: readonly string[],
): TeamMembership {
  return {
    accountId: record.accountId,
    membershipId: record.membershipId,
    projectIds,
    revision: record.revision,
    role: record.role,
    state: record.state,
    teamId: record.teamId,
    tenantId: record.tenantId,
  };
}

function toEligibilityDevice(device: RegisteredDeviceRecord) {
  return {
    accountId: device.accountId,
    deviceId: device.deviceId,
    publicKeyState:
      device.state === "trusted" &&
      device.revokedAt === null &&
      device.publicKey.length > 0 &&
      device.publicKeyFingerprint.length > 0
        ? ("active" as const)
        : ("revoked" as const),
    state: device.state === "trusted" ? ("active" as const) : ("revoked" as const),
  };
}

function toEligibleRecipient(
  candidate: CloudTeamProjectKeyRecipientCandidate,
  teamId: string,
  projectId: string,
  keyVersion: number,
): CloudTeamProjectKeyEligibleRecipient {
  return {
    algorithm: candidate.device.algorithm,
    assignmentId: candidate.assignment.assignmentId,
    assignmentRevision: candidate.assignment.revision,
    deviceId: candidate.device.deviceId,
    keyVersion,
    membershipId: candidate.membership.membershipId,
    membershipRevision: candidate.membership.revision,
    projectId,
    publicKey: candidate.device.publicKey,
    publicKeyFingerprint: candidate.device.publicKeyFingerprint,
    recipientKind: "active_assigned_team_member_device",
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    teamId,
  };
}

function toCloudEnvelope(record: CloudTeamProjectKeyEnvelopeRecord): CloudTeamProjectKeyEnvelope {
  return {
    algorithm: record.algorithm,
    assignmentId: record.assignmentId,
    assignmentRevision: record.assignmentRevision,
    ciphertext: record.ciphertext,
    createdAt: record.createdAt.toISOString(),
    encapsulatedKey: record.encapsulatedKey,
    envelopeId: record.envelopeId,
    envelopeKind: "team_project_member_device",
    keyVersion: record.keyVersion,
    membershipId: record.membershipId,
    membershipRevision: record.membershipRevision,
    projectId: record.projectId,
    recipientDeviceId: record.recipientDeviceId,
    recipientPublicKey: record.recipientPublicKey,
    recipientPublicKeyFingerprint: record.recipientPublicKeyFingerprint,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    senderDeviceId: record.senderDeviceId,
    senderPublicKey: record.senderPublicKey,
    senderPublicKeyFingerprint: record.senderPublicKeyFingerprint,
    teamId: record.teamId,
  };
}

function assertRequestScope(
  request: CloudTeamProjectKeyEnvelopePublishRequest,
  teamId: string,
  projectId: string,
  keyVersion: number,
  senderDeviceId: string,
): void {
  if (
    request.teamId !== teamId ||
    request.projectId !== projectId ||
    request.keyVersion !== keyVersion ||
    request.senderDeviceId !== senderDeviceId
  ) {
    throw accessForbidden();
  }
}

function requireKeyVersion(keyVersion: number): void {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1 || keyVersion > 2_147_483_647) {
    throw validationFailed("The project key version is invalid.");
  }
}

function replayEnvelope(
  idempotency: CloudIdempotencyRecord,
  requestId: string,
): CloudTeamProjectKeyEnvelopeResponse {
  if (
    idempotency.resultKind !== "team_project_key_envelope" ||
    typeof idempotency.responseSnapshot !== "object" ||
    idempotency.responseSnapshot === null ||
    hashCanonicalJson(idempotency.responseSnapshot) !== idempotency.resultDigestSha256
  ) {
    throw new Error("The team project-key idempotency record is internally inconsistent.");
  }
  return CloudTeamProjectKeyEnvelopeResponseSchema.parse({
    ...idempotency.responseSnapshot,
    requestId,
  });
}
