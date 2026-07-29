import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  authorizeTeamAction,
  planMembershipMutation,
  type AccessAction,
  type AccessDecision,
  type TeamMembership,
  type TeamRole,
} from "@inkshadow/access-core";
import {
  CloudProjectAssignmentListResponseSchema,
  CloudProjectAssignmentResponseSchema,
  CloudTeamInvitationAcceptanceResponseSchema,
  CloudTeamInvitationResponseSchema,
  CloudTeamListResponseSchema,
  CloudTeamMemberListResponseSchema,
  CloudTeamMembershipResponseSchema,
  CloudTeamResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudApiOperationId,
  type CloudProjectAssignment,
  type CloudProjectAssignmentListResponse,
  type CloudProjectAssignmentResponse,
  type CloudProjectAssignmentSetRequest,
  type CloudTeam,
  type CloudTeamCreateRequest,
  type CloudTeamInvitation,
  type CloudTeamInvitationAcceptanceResponse,
  type CloudTeamInvitationAcceptRequest,
  type CloudTeamInvitationCreateRequest,
  type CloudTeamInvitationResponse,
  type CloudTeamListResponse,
  type CloudTeamMemberListResponse,
  type CloudTeamMemberRoleChangeRequest,
  type CloudTeamMembership,
  type CloudTeamMembershipResponse,
  type CloudTeamMembershipRevokeRequest,
  type CloudTeamResponse,
} from "@inkshadow/contracts";

import type { CloudIdempotencyRecord, CloudPageAnchor } from "../domain/records.js";
import type { TeamInvitationOutboxRecord } from "../domain/team-invitation-outbox-record.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamAuditEventRecord,
  CloudTeamInvitationRecord,
  CloudTeamMembershipRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type { CloudTeamStore, CloudTeamTransaction } from "../repository/team-store.js";
import {
  createIdempotencyScopeHash,
  hashCanonicalJson,
  hashUtf8,
} from "../security/canonical-hash.js";
import { InvalidPageCursorError, type CloudPageCursorCodec } from "../security/page-cursor.js";
import type {
  ProtectedTeamInvitationToken,
  TeamInvitationTokenContext,
  TeamInvitationTokenProtector,
} from "../security/team-invitation-token-protector.js";
import type { UuidV7Factory } from "../security/uuid-v7.js";
import {
  accessForbidden,
  idempotencyConflict,
  resourceNotFound,
  revisionConflict,
  serviceUnavailable,
  sessionExpired,
  validationFailed,
} from "./errors.js";
import type { CloudServiceError } from "./errors.js";
import type { CloudMutationContext, CloudPrincipal, CloudReadContext } from "./identity-service.js";

const DEFAULT_IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_INVITATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MAXIMUM_PAGE_SIZE = 1_024;

export class UnavailableTeamInvitationTokenProtector implements TeamInvitationTokenProtector {
  public protect(token: string, context: TeamInvitationTokenContext): ProtectedTeamInvitationToken {
    void token;
    void context;
    throw serviceUnavailable();
  }

  public unprotect(
    protectedToken: ProtectedTeamInvitationToken,
    context: TeamInvitationTokenContext,
  ): string {
    void protectedToken;
    void context;
    throw serviceUnavailable();
  }
}

export interface CloudTeamServiceOptions {
  readonly clock?: () => Date;
  readonly idempotencyLifetimeMs?: number;
  readonly invitationTokenProtector: TeamInvitationTokenProtector;
  readonly pageCursorCodec: CloudPageCursorCodec;
  readonly store: CloudTeamStore;
  readonly tokenFactory?: () => string;
  readonly uuid: UuidV7Factory;
}

interface AuthorizedTeamScope {
  readonly actor: CloudTeamMembershipRecord;
  readonly team: CloudTeamRecord;
}

type MutationOutcome<Value> = { readonly error: CloudServiceError } | { readonly value: Value };

export class CloudTeamService {
  private readonly clock: () => Date;
  private readonly idempotencyLifetimeMs: number;
  private readonly invitationTokenProtector: TeamInvitationTokenProtector;
  private readonly pageCursorCodec: CloudPageCursorCodec;
  private readonly store: CloudTeamStore;
  private readonly tokenFactory: () => string;
  private readonly uuid: UuidV7Factory;

  public constructor(options: CloudTeamServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.idempotencyLifetimeMs = options.idempotencyLifetimeMs ?? DEFAULT_IDEMPOTENCY_LIFETIME_MS;
    this.invitationTokenProtector = options.invitationTokenProtector;
    this.pageCursorCodec = options.pageCursorCodec;
    this.store = options.store;
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.uuid = options.uuid;
    if (!Number.isSafeInteger(this.idempotencyLifetimeMs) || this.idempotencyLifetimeMs <= 0) {
      throw new Error("The team idempotency lifetime must be a positive integer.");
    }
  }

  public async createTeam(
    principal: CloudPrincipal,
    request: CloudTeamCreateRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamResponse> {
    const now = this.now();
    const requestHash = hashCanonicalJson(request);
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, now);
      const existing = await this.findIdempotency(
        transaction,
        "teams.create",
        principal.accountId,
        context,
        requestHash,
        now,
      );
      if (existing !== null) {
        return replaySnapshot(CloudTeamResponseSchema, existing, "team", context.requestId);
      }

      const teamId = this.uuid();
      const membershipId = this.uuid();
      await transaction.setTeamScope(principal.accountId, teamId);
      const team: CloudTeamRecord = {
        archivedAt: null,
        createdAt: now,
        displayName: request.displayName,
        revision: 1,
        state: "active",
        teamId,
        tenantId: principal.accountId,
        updatedAt: now,
      };
      const membership: CloudTeamMembershipRecord = {
        accountId: principal.accountId,
        createdAt: now,
        membershipId,
        revision: 1,
        revokedAt: null,
        role: "owner",
        state: "active",
        teamId,
        tenantId: principal.accountId,
        updatedAt: now,
      };
      await transaction.insertTeam(team);
      await transaction.insertMembership(membership);
      const response = CloudTeamResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        team: toCloudTeam(team),
      });
      await transaction.insertAuditEvent(
        this.audit({
          action: "team.created",
          actor: membership,
          context,
          now,
          reason: "allowed",
          resourceId: teamId,
          resourceType: "team",
          result: "allowed",
          team,
          redactedDiff: { displayNameChanged: true, ownerCount: 1 },
        }),
      );
      await this.insertIdempotency(transaction, {
        actorAccountId: principal.accountId,
        context,
        now,
        operationId: "teams.create",
        requestHash,
        response,
        responseStatus: 201,
        resultKind: "team",
        resultResourceId: teamId,
      });
      return response;
    });
  }

  public async listTeams(
    principal: CloudPrincipal,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudTeamListResponse> {
    const pageSize = requirePageSize(limit);
    const anchor = this.decodeCursor("teams", cursor);
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      await transaction.clearTeamScope();
      const memberships = await transaction.listActiveMembershipsForAccount(
        principal.accountId,
        pageSize + 1,
        anchor,
      );
      const pageMemberships = memberships.slice(0, pageSize);
      const teams: CloudTeam[] = [];
      for (const membership of pageMemberships) {
        await transaction.setTeamScope(membership.tenantId, membership.teamId);
        const team = await transaction.findTeam(membership.tenantId, membership.teamId);
        if (team?.state !== "active") {
          continue;
        }
        const decision = authorizeTeamAction(toAccessMembership(membership, null), {
          action: "team.read",
          projectId: null,
          resourceState: team.state,
          resourceType: "team",
          teamId: team.teamId,
          tenantId: team.tenantId,
        });
        if (decision.allowed) {
          teams.push(toCloudTeam(team));
        }
      }
      const last = pageMemberships.at(-1);
      return CloudTeamListResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        teams,
        nextCursor:
          memberships.length > pageSize && last !== undefined
            ? this.pageCursorCodec.encode("teams", anchorForMembership(last))
            : null,
      });
    });
  }

  public async listMembers(
    principal: CloudPrincipal,
    teamId: string,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudTeamMemberListResponse> {
    const pageSize = requirePageSize(limit);
    const anchor = this.decodeCursor("team_members", cursor);
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      const scope = await this.requireTeamScope(
        transaction,
        principal,
        teamId,
        "member.list",
        false,
      );
      const candidates = await transaction.listMemberships(
        scope.team.tenantId,
        teamId,
        pageSize + 1,
        anchor,
      );
      const page = candidates.slice(0, pageSize);
      const last = page.at(-1);
      return CloudTeamMemberListResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        memberships: page.map(toCloudMembership),
        nextCursor:
          candidates.length > pageSize && last !== undefined
            ? this.pageCursorCodec.encode("team_members", anchorForMembership(last))
            : null,
      });
    });
  }

  public async createInvitation(
    principal: CloudPrincipal,
    teamId: string,
    request: CloudTeamInvitationCreateRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamInvitationResponse> {
    const now = this.now();
    const expiresAt = new Date(request.expiresAt);
    if (
      expiresAt.getTime() <= now.getTime() ||
      expiresAt.getTime() - now.getTime() > MAXIMUM_INVITATION_LIFETIME_MS
    ) {
      throw validationFailed("A team invitation must expire within the next 30 days.");
    }
    const requestHash = hashCanonicalJson({ teamId, request });
    try {
      return await this.store.transaction(async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        const existing = await this.findIdempotency(
          transaction,
          "teamInvitations.create",
          principal.accountId,
          context,
          requestHash,
          now,
        );
        if (existing !== null) {
          return replaySnapshot(
            CloudTeamInvitationResponseSchema,
            existing,
            "team_invitation",
            context.requestId,
          );
        }
        const scope = await this.requireTeamScope(
          transaction,
          principal,
          teamId,
          "member.invite",
          true,
        );
        if (
          scope.actor.role !== "owner" &&
          (request.role === "admin" || request.role === "finance_admin")
        ) {
          throw accessForbidden();
        }
        const expiredInvitationCount = await transaction.expirePendingInvitations(
          scope.team.tenantId,
          teamId,
          request.inviteeEmail,
          now,
        );
        if (
          await transaction.hasActiveMembershipForEmail(
            scope.team.tenantId,
            teamId,
            request.inviteeEmail,
          )
        ) {
          throw revisionConflict();
        }
        const invitationToken = this.tokenFactory();
        if (!/^[A-Za-z0-9_-]{43}$/u.test(invitationToken)) {
          throw new Error("The team invitation token factory returned invalid material.");
        }
        const invitationId = this.uuid();
        const deliveryId = invitationId;
        const tokenContext: TeamInvitationTokenContext = {
          deliveryId,
          invitationId,
          teamId,
          tenantId: scope.team.tenantId,
        };
        const protectedToken = this.invitationTokenProtector.protect(invitationToken, tokenContext);
        const invitation: CloudTeamInvitationRecord = {
          acceptedAt: null,
          acceptedMembershipId: null,
          createdAt: now,
          expiresAt,
          invitationId,
          invitedByMembershipId: scope.actor.membershipId,
          inviteeEmail: request.inviteeEmail,
          revision: 1,
          revokedAt: null,
          role: request.role,
          state: "pending",
          teamId,
          tenantId: scope.team.tenantId,
          tokenHashSha256: hashUtf8(invitationToken),
          updatedAt: now,
        };
        const outbox: TeamInvitationOutboxRecord = {
          attemptCount: 0,
          availableAt: now,
          createdAt: now,
          deliveredAt: null,
          deliveryId,
          encryptionKeyId: protectedToken.encryptionKeyId,
          invitationId,
          lastErrorCode: null,
          leaseExpiresAt: null,
          leaseOwner: null,
          revision: 1,
          state: "pending",
          teamId,
          tenantId: scope.team.tenantId,
          tokenAuthTag: protectedToken.authTag,
          tokenCiphertext: protectedToken.ciphertext,
          tokenNonce: protectedToken.nonce,
          updatedAt: now,
        };
        await transaction.insertInvitation(invitation);
        await transaction.insertInvitationOutbox(outbox);
        const response = CloudTeamInvitationResponseSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: context.requestId,
          invitation: toCloudInvitation(invitation),
        });
        await transaction.insertAuditEvent(
          this.audit({
            action: "team_invitation.created",
            actor: scope.actor,
            context,
            now,
            reason: "allowed",
            resourceId: invitation.invitationId,
            resourceType: "invitation",
            result: "allowed",
            team: scope.team,
            redactedDiff: {
              expiresAt: invitation.expiresAt.toISOString(),
              expiredInvitationCount,
              inviteeEmailHashSha256: hashUtf8(invitation.inviteeEmail),
              role: invitation.role,
            },
          }),
        );
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "teamInvitations.create",
          requestHash,
          response,
          responseStatus: 201,
          resultKind: "team_invitation",
          resultResourceId: invitation.invitationId,
        });
        return response;
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw revisionConflict();
      }
      throw error;
    }
  }

  public async acceptInvitation(
    principal: CloudPrincipal,
    invitationId: string,
    request: CloudTeamInvitationAcceptRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamInvitationAcceptanceResponse> {
    const now = this.now();
    const requestHash = hashCanonicalJson({
      invitationId,
      expectedRevision: request.expectedRevision,
    });
    try {
      return await this.store.transaction(async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        await transaction.clearTeamScope();
        const discovered = await transaction.findInvitationForInvitee(invitationId);
        const principalEmail = await transaction.findActiveAccountEmail(principal.accountId);
        if (discovered?.inviteeEmail !== principalEmail) {
          throw resourceNotFound();
        }
        await transaction.setTeamScope(discovered.tenantId, discovered.teamId);
        const team = await transaction.lockTeam(discovered.tenantId, discovered.teamId);
        const invitation = await transaction.findInvitationForInvitee(invitationId, true);
        if (team?.state !== "active" || invitation?.inviteeEmail !== principalEmail) {
          throw resourceNotFound();
        }
        if (!tokenHashesMatch(invitation.tokenHashSha256, request.invitationToken)) {
          throw revisionConflict();
        }
        const existing = await this.findIdempotency(
          transaction,
          "teamInvitations.accept",
          principal.accountId,
          context,
          requestHash,
          now,
        );
        if (existing !== null) {
          return replaySnapshot(
            CloudTeamInvitationAcceptanceResponseSchema,
            existing,
            "team_invitation_acceptance",
            context.requestId,
          );
        }
        if (
          invitation.state !== "pending" ||
          invitation.revision !== request.expectedRevision ||
          invitation.expiresAt.getTime() <= now.getTime()
        ) {
          throw revisionConflict();
        }
        const membership: CloudTeamMembershipRecord = {
          accountId: principal.accountId,
          createdAt: now,
          membershipId: this.uuid(),
          revision: 1,
          revokedAt: null,
          role: invitation.role,
          state: "active",
          teamId: invitation.teamId,
          tenantId: invitation.tenantId,
          updatedAt: now,
        };
        await transaction.insertMembership(membership);
        const accepted: CloudTeamInvitationRecord = {
          ...invitation,
          acceptedAt: now,
          acceptedMembershipId: membership.membershipId,
          revision: invitation.revision + 1,
          state: "accepted",
          updatedAt: now,
        };
        if (!(await transaction.updateInvitationCas(accepted, invitation.revision))) {
          throw revisionConflict();
        }
        await transaction.cancelInvitationOutbox(
          invitation.tenantId,
          invitation.teamId,
          invitation.invitationId,
          now,
          "INVITATION_ACCEPTED",
        );
        const response = CloudTeamInvitationAcceptanceResponseSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: context.requestId,
          invitation: toCloudInvitation(accepted),
          membership: toCloudMembership(membership),
        });
        await transaction.insertAuditEvent(
          this.audit({
            action: "team_invitation.accepted",
            actor: membership,
            context,
            now,
            reason: "allowed",
            resourceId: invitation.invitationId,
            resourceType: "invitation",
            result: "allowed",
            team,
            redactedDiff: { membershipId: membership.membershipId, role: membership.role },
          }),
        );
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "teamInvitations.accept",
          requestHash,
          response,
          responseStatus: 200,
          resultKind: "team_invitation_acceptance",
          resultResourceId: invitation.invitationId,
        });
        return response;
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw revisionConflict();
      }
      throw error;
    }
  }

  public changeMemberRole(
    principal: CloudPrincipal,
    teamId: string,
    membershipId: string,
    request: CloudTeamMemberRoleChangeRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamMembershipResponse> {
    return this.mutateMembership(
      principal,
      teamId,
      membershipId,
      request.expectedRevision,
      { kind: "change_role", role: request.role },
      context,
    );
  }

  public revokeMembership(
    principal: CloudPrincipal,
    teamId: string,
    membershipId: string,
    request: CloudTeamMembershipRevokeRequest,
    context: CloudMutationContext,
  ): Promise<CloudTeamMembershipResponse> {
    return this.mutateMembership(
      principal,
      teamId,
      membershipId,
      request.expectedRevision,
      { kind: "revoke" },
      context,
    );
  }

  public async listProjectAssignments(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudProjectAssignmentListResponse> {
    const pageSize = requirePageSize(limit);
    const anchor = this.decodeCursor("project_assignments", cursor);
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      const scope = await this.requireTeamScope(transaction, principal, teamId, null, false);
      await this.requireProjectAuthorization(
        transaction,
        scope,
        principal,
        projectId,
        "project.manage_assignment",
      );
      const candidates = await transaction.listAssignments(
        scope.team.tenantId,
        teamId,
        projectId,
        pageSize + 1,
        anchor,
      );
      const page = candidates.slice(0, pageSize);
      const last = page.at(-1);
      return CloudProjectAssignmentListResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        assignments: page.map(toCloudAssignment),
        nextCursor:
          candidates.length > pageSize && last !== undefined
            ? this.pageCursorCodec.encode("project_assignments", {
                createdAt: last.createdAt,
                id: last.assignmentId,
              })
            : null,
      });
    });
  }

  public async setProjectAssignment(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    membershipId: string,
    request: CloudProjectAssignmentSetRequest,
    context: CloudMutationContext,
  ): Promise<CloudProjectAssignmentResponse> {
    const now = this.now();
    const requestHash = hashCanonicalJson({ membershipId, projectId, request, teamId });
    const outcome = await this.store.transaction<MutationOutcome<CloudProjectAssignmentResponse>>(
      async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        const existingIdempotency = await this.findIdempotency(
          transaction,
          "projectAssignments.set",
          principal.accountId,
          context,
          requestHash,
          now,
        );
        if (existingIdempotency !== null) {
          return {
            value: replaySnapshot(
              CloudProjectAssignmentResponseSchema,
              existingIdempotency,
              "project_assignment",
              context.requestId,
            ),
          };
        }
        const scope = await this.requireTeamScope(transaction, principal, teamId, null, true);
        const authorization = await this.authorizeProjectAction(
          transaction,
          scope,
          principal,
          projectId,
          "project.manage_assignment",
        );
        if (!authorization.allowed) {
          await transaction.insertAuditEvent(
            this.audit({
              action: "project_assignment.set",
              actor: scope.actor,
              context,
              now,
              reason: authorization.reason,
              resourceId: projectId,
              resourceType: "project_assignment",
              result: "denied",
              team: scope.team,
              redactedDiff: { desiredState: request.desiredState, membershipId },
            }),
          );
          return { error: accessForbidden() };
        }
        const target = await transaction.findMembership(
          scope.team.tenantId,
          teamId,
          membershipId,
          true,
        );
        if (target?.state !== "active") {
          return { error: resourceNotFound() };
        }
        const existing = await transaction.findAssignment(
          scope.team.tenantId,
          teamId,
          projectId,
          membershipId,
          true,
        );
        let assignment: CloudProjectAssignmentRecord;
        if (existing === null) {
          if (request.expectedRevision !== null || request.desiredState !== "active") {
            return { error: revisionConflict() };
          }
          assignment = {
            assignmentId: this.uuid(),
            createdAt: now,
            grantedByMembershipId: scope.actor.membershipId,
            membershipId,
            projectId,
            revision: 1,
            revokedAt: null,
            revokedByMembershipId: null,
            state: "active",
            teamId,
            tenantId: scope.team.tenantId,
            updatedAt: now,
          };
          await transaction.insertAssignment(assignment);
        } else {
          if (
            request.expectedRevision === null ||
            request.expectedRevision !== existing.revision ||
            request.desiredState === existing.state ||
            existing.revision >= Number.MAX_SAFE_INTEGER
          ) {
            return { error: revisionConflict() };
          }
          assignment = {
            ...existing,
            grantedByMembershipId:
              request.desiredState === "active"
                ? scope.actor.membershipId
                : existing.grantedByMembershipId,
            revision: existing.revision + 1,
            revokedAt: request.desiredState === "revoked" ? now : null,
            revokedByMembershipId:
              request.desiredState === "revoked" ? scope.actor.membershipId : null,
            state: request.desiredState,
            updatedAt: now,
          };
          if (!(await transaction.updateAssignmentCas(assignment, existing.revision))) {
            return { error: revisionConflict() };
          }
        }
        const response = CloudProjectAssignmentResponseSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: context.requestId,
          assignment: toCloudAssignment(assignment),
        });
        await transaction.insertAuditEvent(
          this.audit({
            action: "project_assignment.set",
            actor: scope.actor,
            context,
            now,
            reason: "allowed",
            resourceId: assignment.assignmentId,
            resourceType: "project_assignment",
            result: "allowed",
            team: scope.team,
            redactedDiff: {
              membershipId,
              projectId,
              revision: assignment.revision,
              state: assignment.state,
            },
          }),
        );
        await this.insertIdempotency(transaction, {
          actorAccountId: principal.accountId,
          context,
          now,
          operationId: "projectAssignments.set",
          requestHash,
          response,
          responseStatus: 200,
          resultKind: "project_assignment",
          resultResourceId: assignment.assignmentId,
        });
        return { value: response };
      },
    );
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  }

  /**
   * Revalidates a project-scoped business action at execution time. This
   * decision is intentionally not a project-key-envelope eligibility proof.
   */
  public async authorizeProjectBusinessAction(
    principal: CloudPrincipal,
    teamId: string,
    projectId: string,
    action: AccessAction,
  ): Promise<AccessDecision> {
    return this.store.transaction(async (transaction) => {
      await this.requirePrincipal(transaction, principal, this.now());
      const scope = await this.requireTeamScope(transaction, principal, teamId, null, false);
      return this.authorizeProjectAction(transaction, scope, principal, projectId, action);
    });
  }

  private async mutateMembership(
    principal: CloudPrincipal,
    teamId: string,
    membershipId: string,
    expectedRevision: number,
    mutation:
      { readonly kind: "change_role"; readonly role: TeamRole } | { readonly kind: "revoke" },
    context: CloudMutationContext,
  ): Promise<CloudTeamMembershipResponse> {
    const now = this.now();
    const operationId: CloudApiOperationId =
      mutation.kind === "change_role" ? "teamMembers.changeRole" : "teamMembers.revoke";
    const resultKind = "team_membership" as const;
    const requestHash = hashCanonicalJson({
      expectedRevision,
      membershipId,
      mutation,
      teamId,
    });
    const outcome = await this.store.transaction<MutationOutcome<CloudTeamMembershipResponse>>(
      async (transaction) => {
        await this.requirePrincipal(transaction, principal, now);
        const existingIdempotency = await this.findIdempotency(
          transaction,
          operationId,
          principal.accountId,
          context,
          requestHash,
          now,
        );
        if (existingIdempotency !== null) {
          return {
            value: replaySnapshot(
              CloudTeamMembershipResponseSchema,
              existingIdempotency,
              resultKind,
              context.requestId,
            ),
          };
        }
        const scope = await this.requireTeamScope(transaction, principal, teamId, null, true);
        const target = await transaction.findMembership(
          scope.team.tenantId,
          teamId,
          membershipId,
          true,
        );
        if (target === null) {
          return { error: resourceNotFound() };
        }
        const owners = await transaction.lockActiveOwners(scope.team.tenantId, teamId);
        const plan = planMembershipMutation({
          activeOwnerCount: owners.length,
          actor: toAccessMembership(scope.actor, null),
          expectedTargetRevision: expectedRevision,
          mutation,
          occurredAt: now.toISOString(),
          requestId: context.requestId,
          target: toAccessMembership(target, null),
        });
        if (!plan.allowed) {
          await transaction.insertAuditEvent(
            this.audit({
              action:
                mutation.kind === "change_role"
                  ? "team_membership.role_changed"
                  : "team_membership.revoked",
              actor: scope.actor,
              context,
              now,
              reason: plan.reason,
              resourceId: target.membershipId,
              resourceType: "membership",
              result: "denied",
              team: scope.team,
              redactedDiff: plan.auditIntent.redactedDiff,
            }),
          );
          return {
            error:
              plan.reason === "revision_conflict" || plan.reason === "revision_exhausted"
                ? revisionConflict()
                : accessForbidden(),
          };
        }
        const next: CloudTeamMembershipRecord = {
          ...target,
          revision: plan.nextTarget.revision,
          revokedAt: plan.nextTarget.state === "revoked" ? now : null,
          role: plan.nextTarget.role,
          state: plan.nextTarget.state,
          updatedAt: now,
        };
        if (!(await transaction.updateMembershipCas(next, expectedRevision))) {
          return { error: revisionConflict() };
        }
        const revokedAssignmentCount =
          next.state === "revoked"
            ? await transaction.revokeActiveAssignmentsForMembership(
                next.tenantId,
                next.teamId,
                next.membershipId,
                scope.actor.membershipId,
                now,
              )
            : 0;
        const response = CloudTeamMembershipResponseSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: context.requestId,
          membership: toCloudMembership(next),
        });
        await transaction.insertAuditEvent(
          this.audit({
            action:
              mutation.kind === "change_role"
                ? "team_membership.role_changed"
                : "team_membership.revoked",
            actor: scope.actor,
            context,
            now,
            reason: "allowed",
            resourceId: target.membershipId,
            resourceType: "membership",
            result: "allowed",
            team: scope.team,
            redactedDiff: {
              ...plan.auditIntent.redactedDiff,
              revokedAssignmentCount,
            },
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
          resultKind,
          resultResourceId: membershipId,
        });
        return { value: response };
      },
    );
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  }

  private async requireTeamScope(
    transaction: CloudTeamTransaction,
    principal: CloudPrincipal,
    teamId: string,
    action: AccessAction | null,
    forUpdate: boolean,
  ): Promise<AuthorizedTeamScope> {
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
    if (action !== null) {
      const decision = authorizeTeamAction(toAccessMembership(actor, null), {
        action,
        projectId: null,
        resourceState: team.state,
        resourceType: action === "team.read" ? "team" : "membership",
        teamId,
        tenantId: team.tenantId,
      });
      if (!decision.allowed) {
        throw accessForbidden();
      }
    }
    return { actor, team };
  }

  private async requireProjectAuthorization(
    transaction: CloudTeamTransaction,
    scope: AuthorizedTeamScope,
    principal: CloudPrincipal,
    projectId: string,
    action: AccessAction,
  ): Promise<void> {
    const decision = await this.authorizeProjectAction(
      transaction,
      scope,
      principal,
      projectId,
      action,
    );
    if (!decision.allowed) {
      throw accessForbidden();
    }
  }

  private async authorizeProjectAction(
    transaction: CloudTeamTransaction,
    scope: AuthorizedTeamScope,
    principal: CloudPrincipal,
    projectId: string,
    action: AccessAction,
  ): Promise<AccessDecision> {
    const project = await transaction.findProject(
      scope.team.tenantId,
      projectId,
      action === "project.manage_assignment",
    );
    if (project === null) {
      throw resourceNotFound();
    }
    const assignedProjectIds = await transaction.listActiveProjectIdsForMembership(
      scope.team.tenantId,
      scope.team.teamId,
      scope.actor.membershipId,
    );
    const effectiveProjectIds =
      project.ownerAccountId === principal.accountId
        ? [...new Set([...assignedProjectIds, projectId])].sort()
        : assignedProjectIds;
    const resourceType = action.startsWith("review.")
      ? "review"
      : action === "project.delete" || action === "project.manage_assignment"
        ? "project_metadata"
        : action.startsWith("key.")
          ? "project_key_metadata"
          : "project_content";
    return authorizeTeamAction(toAccessMembership(scope.actor, effectiveProjectIds), {
      action,
      projectId,
      resourceState: project.state,
      resourceType,
      teamId: scope.team.teamId,
      tenantId: scope.team.tenantId,
    });
  }

  private async requirePrincipal(
    transaction: CloudTeamTransaction,
    principal: CloudPrincipal,
    now: Date,
  ): Promise<void> {
    await transaction.setPrincipal(principal.accountId);
    if (!(await transaction.assertPrincipalActive(principal, now))) {
      throw sessionExpired();
    }
  }

  private decodeCursor(
    kind: "project_assignments" | "team_members" | "teams",
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

  private async insertIdempotency(
    transaction: CloudTeamTransaction,
    options: {
      readonly actorAccountId: string;
      readonly context: CloudMutationContext;
      readonly now: Date;
      readonly operationId: CloudApiOperationId;
      readonly requestHash: string;
      readonly response: unknown;
      readonly responseStatus: number;
      readonly resultKind: CloudIdempotencyRecord["resultKind"];
      readonly resultResourceId: string;
    },
  ): Promise<void> {
    await transaction.insertIdempotency({
      actorAccountId: options.actorAccountId,
      createdAt: options.now,
      expiresAt: new Date(options.now.getTime() + this.idempotencyLifetimeMs),
      idempotencyKeyHashSha256: hashUtf8(options.context.idempotencyKey),
      operationId: options.operationId,
      requestHashSha256: options.requestHash,
      responseSnapshot: options.response,
      responseStatus: options.responseStatus,
      resultDigestSha256: hashCanonicalJson(options.response),
      resultKind: options.resultKind,
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
    readonly actor: CloudTeamMembershipRecord;
    readonly context: CloudReadContext;
    readonly now: Date;
    readonly reason: string;
    readonly redactedDiff: Readonly<Record<string, unknown>>;
    readonly resourceId: string | null;
    readonly resourceType: CloudTeamAuditEventRecord["resourceType"];
    readonly result: CloudTeamAuditEventRecord["result"];
    readonly team: CloudTeamRecord;
  }): CloudTeamAuditEventRecord {
    return {
      action: options.action,
      actorAccountId: options.actor.accountId,
      actorMembershipId: options.actor.membershipId,
      createdAt: options.now,
      eventId: this.uuid(),
      reason: options.reason,
      redactedDiff: options.redactedDiff,
      requestId: options.context.requestId,
      resourceId: options.resourceId,
      resourceType: options.resourceType,
      result: options.result,
      teamId: options.team.teamId,
      tenantId: options.team.tenantId,
    };
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The team service clock returned an invalid timestamp.");
    }
    return new Date(value);
  }
}

function toCloudTeam(record: CloudTeamRecord): CloudTeam {
  return {
    archivedAt: record.archivedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    displayName: record.displayName,
    revision: record.revision,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    state: record.state,
    teamId: record.teamId,
    tenantId: record.tenantId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toCloudMembership(record: CloudTeamMembershipRecord): CloudTeamMembership {
  return {
    accountId: record.accountId,
    createdAt: record.createdAt.toISOString(),
    membershipId: record.membershipId,
    revision: record.revision,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    role: record.role,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    state: record.state,
    teamId: record.teamId,
    tenantId: record.tenantId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toCloudInvitation(record: CloudTeamInvitationRecord): CloudTeamInvitation {
  return {
    acceptedAt: record.acceptedAt?.toISOString() ?? null,
    acceptedMembershipId: record.acceptedMembershipId,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    invitationId: record.invitationId,
    invitedByMembershipId: record.invitedByMembershipId,
    inviteeEmail: record.inviteeEmail,
    revision: record.revision,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    role: record.role,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    state: record.state,
    teamId: record.teamId,
    tenantId: record.tenantId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toCloudAssignment(record: CloudProjectAssignmentRecord): CloudProjectAssignment {
  return {
    assignmentId: record.assignmentId,
    createdAt: record.createdAt.toISOString(),
    grantedByMembershipId: record.grantedByMembershipId,
    membershipId: record.membershipId,
    projectId: record.projectId,
    revision: record.revision,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    revokedByMembershipId: record.revokedByMembershipId,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    state: record.state,
    teamId: record.teamId,
    tenantId: record.tenantId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toAccessMembership(
  record: CloudTeamMembershipRecord,
  projectIds: readonly string[] | null,
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

function anchorForMembership(record: CloudTeamMembershipRecord): CloudPageAnchor {
  return { createdAt: record.createdAt, id: record.membershipId };
}

function requirePageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_PAGE_SIZE) {
    throw validationFailed("The requested page size is invalid.");
  }
  return value;
}

function tokenHashesMatch(expectedHash: string, suppliedToken: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const supplied = Buffer.from(hashUtf8(suppliedToken), "hex");
  try {
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  } finally {
    expected.fill(0);
    supplied.fill(0);
  }
}

function replaySnapshot<Output>(
  schema: { readonly parse: (value: unknown) => Output },
  record: CloudIdempotencyRecord,
  expectedKind: CloudIdempotencyRecord["resultKind"],
  requestId: string,
): Output {
  if (
    record.resultKind !== expectedKind ||
    typeof record.responseSnapshot !== "object" ||
    record.responseSnapshot === null ||
    hashCanonicalJson(record.responseSnapshot) !== record.resultDigestSha256
  ) {
    throw new Error("The team idempotency record is internally inconsistent.");
  }
  return schema.parse({ ...record.responseSnapshot, requestId });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
