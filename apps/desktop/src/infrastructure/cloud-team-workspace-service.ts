import type {
  CloudProjectAssignmentListResponse,
  CloudProjectAssignmentResponse,
  CloudProjectAssignmentSetRequest,
  CloudTeamCreateRequest,
  CloudTeamInvitationAcceptanceResponse,
  CloudTeamInvitationAcceptRequest,
  CloudTeamInvitationCreateRequest,
  CloudTeamInvitationResponse,
  CloudTeamListResponse,
  CloudTeamMemberListResponse,
  CloudTeamMemberRoleChangeRequest,
  CloudTeamMembershipResponse,
  CloudTeamMembershipRevokeRequest,
  CloudTeamResponse,
} from "@inkshadow/contracts";
import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";
import type { UuidV7Generator } from "@inkshadow/domain";

import type { ConfiguredCloudSessionStatus } from "./cloud-session-coordinator";

const PAGE_LIMIT = 1_024;

export interface CloudTeamWorkspaceApi {
  createTeam(
    request: CloudTeamCreateRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamResponse>;
  listTeams(options?: CloudQueryOptions): Promise<CloudTeamListResponse>;
  listTeamMembers(
    teamId: string,
    options?: CloudQueryOptions,
  ): Promise<CloudTeamMemberListResponse>;
  createTeamInvitation(
    teamId: string,
    request: CloudTeamInvitationCreateRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamInvitationResponse>;
  acceptTeamInvitation(
    invitationId: string,
    request: CloudTeamInvitationAcceptRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamInvitationAcceptanceResponse>;
  changeTeamMemberRole(
    teamId: string,
    membershipId: string,
    request: CloudTeamMemberRoleChangeRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamMembershipResponse>;
  revokeTeamMembership(
    teamId: string,
    membershipId: string,
    request: CloudTeamMembershipRevokeRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamMembershipResponse>;
  listProjectAssignments(
    teamId: string,
    projectId: string,
    options?: CloudQueryOptions,
  ): Promise<CloudProjectAssignmentListResponse>;
  setProjectAssignment(
    teamId: string,
    projectId: string,
    membershipId: string,
    request: CloudProjectAssignmentSetRequest,
    options: CloudMutationOptions,
  ): Promise<CloudProjectAssignmentResponse>;
}

interface CloudMutationOptions {
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

interface CloudQueryOptions {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface CloudTeamSessionPort {
  runWithSession<Value>(
    operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Value>;
}

export interface CloudTeamWorkspacePort {
  getCurrentAccountId(signal?: AbortSignal): Promise<string>;
  createTeam(displayName: string, signal?: AbortSignal): Promise<CloudTeamResponse>;
  listTeams(signal?: AbortSignal): Promise<CloudTeamListResponse>;
  listTeamMembers(teamId: string, signal?: AbortSignal): Promise<CloudTeamMemberListResponse>;
  createInvitation(
    teamId: string,
    input: Omit<CloudTeamInvitationCreateRequest, "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<CloudTeamInvitationResponse>;
  acceptInvitation(
    invitationId: string,
    expectedRevision: number,
    invitationToken: string,
    signal?: AbortSignal,
  ): Promise<CloudTeamInvitationAcceptanceResponse>;
  changeMemberRole(
    teamId: string,
    membershipId: string,
    expectedRevision: number,
    role: CloudTeamMemberRoleChangeRequest["role"],
    signal?: AbortSignal,
  ): Promise<CloudTeamMembershipResponse>;
  revokeMembership(
    teamId: string,
    membershipId: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<CloudTeamMembershipResponse>;
  listProjectAssignments(
    teamId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CloudProjectAssignmentListResponse>;
  setProjectAssignment(
    teamId: string,
    projectId: string,
    membershipId: string,
    expectedRevision: number | null,
    desiredState: CloudProjectAssignmentSetRequest["desiredState"],
    signal?: AbortSignal,
  ): Promise<CloudProjectAssignmentResponse>;
}

/**
 * Team operations use the native cloud transport through a session coordinator.
 * Access and refresh credentials never enter this service or the WebView.
 */
export class CloudTeamWorkspaceService implements CloudTeamWorkspacePort {
  public constructor(
    private readonly api: CloudTeamWorkspaceApi,
    private readonly session: CloudTeamSessionPort,
    private readonly ids: UuidV7Generator,
  ) {}

  public getCurrentAccountId(signal?: AbortSignal): Promise<string> {
    return this.withSession((status) => Promise.resolve(status.account.accountId), signal);
  }

  public createTeam(displayName: string, signal?: AbortSignal): Promise<CloudTeamResponse> {
    const idempotencyKey = this.ids.next();
    return this.withSession(
      () =>
        this.api.createTeam(
          {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            displayName,
          },
          mutationOptions(idempotencyKey, signal),
        ),
      signal,
    );
  }

  public listTeams(signal?: AbortSignal): Promise<CloudTeamListResponse> {
    return this.withSession(() => this.api.listTeams(queryOptions(signal)), signal);
  }

  public listTeamMembers(
    teamId: string,
    signal?: AbortSignal,
  ): Promise<CloudTeamMemberListResponse> {
    return this.withSession(() => this.api.listTeamMembers(teamId, queryOptions(signal)), signal);
  }

  public createInvitation(
    teamId: string,
    input: Omit<CloudTeamInvitationCreateRequest, "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<CloudTeamInvitationResponse> {
    const idempotencyKey = this.ids.next();
    return this.withSession(
      () =>
        this.api.createTeamInvitation(
          teamId,
          {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            ...input,
          },
          mutationOptions(idempotencyKey, signal),
        ),
      signal,
    );
  }

  public acceptInvitation(
    invitationId: string,
    expectedRevision: number,
    invitationToken: string,
    signal?: AbortSignal,
  ): Promise<CloudTeamInvitationAcceptanceResponse> {
    const idempotencyKey = this.ids.next();
    return this.withSession(
      () =>
        this.api.acceptTeamInvitation(
          invitationId,
          {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            expectedRevision,
            invitationToken,
          },
          mutationOptions(idempotencyKey, signal),
        ),
      signal,
    );
  }

  public changeMemberRole(
    teamId: string,
    membershipId: string,
    expectedRevision: number,
    role: CloudTeamMemberRoleChangeRequest["role"],
    signal?: AbortSignal,
  ): Promise<CloudTeamMembershipResponse> {
    const idempotencyKey = this.ids.next();
    return this.withSession(
      () =>
        this.api.changeTeamMemberRole(
          teamId,
          membershipId,
          {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            expectedRevision,
            role,
          },
          mutationOptions(idempotencyKey, signal),
        ),
      signal,
    );
  }

  public revokeMembership(
    teamId: string,
    membershipId: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<CloudTeamMembershipResponse> {
    const idempotencyKey = this.ids.next();
    return this.withSession(
      () =>
        this.api.revokeTeamMembership(
          teamId,
          membershipId,
          {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            expectedRevision,
          },
          mutationOptions(idempotencyKey, signal),
        ),
      signal,
    );
  }

  public listProjectAssignments(
    teamId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CloudProjectAssignmentListResponse> {
    return this.withSession(
      () => this.api.listProjectAssignments(teamId, projectId, queryOptions(signal)),
      signal,
    );
  }

  public setProjectAssignment(
    teamId: string,
    projectId: string,
    membershipId: string,
    expectedRevision: number | null,
    desiredState: CloudProjectAssignmentSetRequest["desiredState"],
    signal?: AbortSignal,
  ): Promise<CloudProjectAssignmentResponse> {
    const idempotencyKey = this.ids.next();
    return this.withSession(
      () =>
        this.api.setProjectAssignment(
          teamId,
          projectId,
          membershipId,
          {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            expectedRevision,
            desiredState,
          },
          mutationOptions(idempotencyKey, signal),
        ),
      signal,
    );
  }

  private withSession<Value>(
    operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
    signal: AbortSignal | undefined,
  ): Promise<Value> {
    return this.session.runWithSession(operation, signal === undefined ? {} : { signal });
  }
}

function queryOptions(signal: AbortSignal | undefined): CloudQueryOptions {
  return {
    limit: PAGE_LIMIT,
    ...(signal === undefined ? {} : { signal }),
  };
}

function mutationOptions(
  idempotencyKey: string,
  signal: AbortSignal | undefined,
): CloudMutationOptions {
  return {
    idempotencyKey,
    ...(signal === undefined ? {} : { signal }),
  };
}
