import {
  CloudCursorSchema,
  UuidV7Schema,
  type CloudProjectAssignmentListResponse,
  type CloudProjectAssignmentResponse,
  type CloudProjectAssignmentSetRequest,
  type CloudTeamCreateRequest,
  type CloudTeamInvitationAcceptanceResponse,
  type CloudTeamInvitationAcceptRequest,
  type CloudTeamInvitationCreateRequest,
  type CloudTeamInvitationResponse,
  type CloudTeamListResponse,
  type CloudTeamMemberListResponse,
  type CloudTeamMemberRoleChangeRequest,
  type CloudTeamMembershipResponse,
  type CloudTeamMembershipRevokeRequest,
  type CloudTeamProjectCurrentKeyResponse,
  type CloudTeamProjectKeyEligibleRecipientListResponse,
  type CloudTeamProjectKeyEnvelope,
  type CloudTeamProjectKeyEnvelopePublishRequest,
  type CloudTeamProjectKeyEnvelopeResponse,
  type CloudTeamResponse,
} from "@inkshadow/contracts";

import { CloudClientError, isCloudClientError } from "./errors.js";

export interface CloudTeamMutationOptionsInput {
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface CloudTeamQueryOptionsInput {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface CloudTeamExecuteOptions {
  readonly body: unknown;
  readonly idempotencyKey?: string;
  readonly pathParameters?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, string | number | null | undefined>>;
  readonly signal?: AbortSignal;
  readonly validateParsedBody?: (body: unknown, requestId: string) => void;
}

export type CloudTeamOperationId =
  | "projectAssignments.list"
  | "projectAssignments.set"
  | "teamInvitations.accept"
  | "teamInvitations.create"
  | "teamMembers.changeRole"
  | "teamMembers.list"
  | "teamMembers.revoke"
  | "teamProjectKeyEnvelopes.getCurrentDevice"
  | "teamProjectKeyEnvelopes.publish"
  | "teamProjectKeyRecipients.list"
  | "teamProjectKeys.getCurrent"
  | "teams.create"
  | "teams.list";

export type CloudTeamOperationExecutor = <Output>(
  operationId: CloudTeamOperationId,
  options: CloudTeamExecuteOptions,
) => Promise<Output>;

export class CloudTeamClientDelegate {
  public constructor(private readonly execute: CloudTeamOperationExecutor) {}

  public async createTeam(
    request: CloudTeamCreateRequest,
    options: CloudTeamMutationOptionsInput,
  ): Promise<CloudTeamResponse> {
    const response = await this.execute<CloudTeamResponse>(
      "teams.create",
      mutationOptions(request, options),
    );
    if (
      response.team.displayName !== request.displayName.trim() ||
      response.team.state !== "active" ||
      response.team.archivedAt !== null
    ) {
      throw protocolError(
        "Cloud team creation response did not match the requested team.",
        response.requestId,
      );
    }
    return response;
  }

  public listTeams(options: CloudTeamQueryOptionsInput = {}): Promise<CloudTeamListResponse> {
    return this.execute("teams.list", queryOptions(options));
  }

  public async listTeamMembers(
    teamId: string,
    options: CloudTeamQueryOptionsInput = {},
  ): Promise<CloudTeamMemberListResponse> {
    const response = await this.execute<CloudTeamMemberListResponse>("teamMembers.list", {
      ...queryOptions(options),
      pathParameters: { teamId },
    });
    if (response.memberships.some((membership) => membership.teamId !== teamId)) {
      throw protocolError("Cloud team-member response crossed its team scope.", response.requestId);
    }
    return response;
  }

  public async createTeamInvitation(
    teamId: string,
    request: CloudTeamInvitationCreateRequest,
    options: CloudTeamMutationOptionsInput,
  ): Promise<CloudTeamInvitationResponse> {
    const response = await this.execute<CloudTeamInvitationResponse>("teamInvitations.create", {
      ...mutationOptions(request, options),
      pathParameters: { teamId },
    });
    const invitation = response.invitation;
    if (
      invitation.teamId !== teamId ||
      invitation.inviteeEmail !== request.inviteeEmail.trim().toLowerCase() ||
      invitation.role !== request.role ||
      invitation.expiresAt !== request.expiresAt ||
      invitation.state !== "pending"
    ) {
      throw protocolError(
        "Cloud team-invitation response did not match the requested invitation.",
        response.requestId,
      );
    }
    return response;
  }

  public async acceptTeamInvitation(
    invitationId: string,
    request: CloudTeamInvitationAcceptRequest,
    options: CloudTeamMutationOptionsInput,
  ): Promise<CloudTeamInvitationAcceptanceResponse> {
    try {
      const response = await this.execute<CloudTeamInvitationAcceptanceResponse>(
        "teamInvitations.accept",
        {
          ...mutationOptions(request, options),
          pathParameters: { invitationId },
        },
      );
      if (response.invitation.invitationId !== invitationId) {
        throw protocolError(
          "Cloud invitation acceptance response did not match its route scope.",
          response.requestId,
        );
      }
      return response;
    } catch (error: unknown) {
      throw redactSensitiveError(error, request.invitationToken);
    }
  }

  public async changeTeamMemberRole(
    teamId: string,
    membershipId: string,
    request: CloudTeamMemberRoleChangeRequest,
    options: CloudTeamMutationOptionsInput,
  ): Promise<CloudTeamMembershipResponse> {
    const response = await this.execute<CloudTeamMembershipResponse>("teamMembers.changeRole", {
      ...mutationOptions(request, options),
      pathParameters: { membershipId, teamId },
    });
    if (
      response.membership.teamId !== teamId ||
      response.membership.membershipId !== membershipId ||
      response.membership.role !== request.role ||
      response.membership.state !== "active"
    ) {
      throw protocolError(
        "Cloud team-role response did not match the requested membership.",
        response.requestId,
      );
    }
    return response;
  }

  public async revokeTeamMembership(
    teamId: string,
    membershipId: string,
    request: CloudTeamMembershipRevokeRequest,
    options: CloudTeamMutationOptionsInput,
  ): Promise<CloudTeamMembershipResponse> {
    const response = await this.execute<CloudTeamMembershipResponse>("teamMembers.revoke", {
      ...mutationOptions(request, options),
      pathParameters: { membershipId, teamId },
    });
    if (
      response.membership.teamId !== teamId ||
      response.membership.membershipId !== membershipId ||
      response.membership.state !== "revoked"
    ) {
      throw protocolError(
        "Cloud team-membership revocation response did not match the requested membership.",
        response.requestId,
      );
    }
    return response;
  }

  public async listProjectAssignments(
    teamId: string,
    projectId: string,
    options: CloudTeamQueryOptionsInput = {},
  ): Promise<CloudProjectAssignmentListResponse> {
    const response = await this.execute<CloudProjectAssignmentListResponse>(
      "projectAssignments.list",
      {
        ...queryOptions(options),
        pathParameters: { projectId, teamId },
      },
    );
    if (
      response.assignments.some(
        (assignment) => assignment.teamId !== teamId || assignment.projectId !== projectId,
      )
    ) {
      throw protocolError(
        "Cloud project-assignment response crossed its team or project scope.",
        response.requestId,
      );
    }
    return response;
  }

  public async setProjectAssignment(
    teamId: string,
    projectId: string,
    membershipId: string,
    request: CloudProjectAssignmentSetRequest,
    options: CloudTeamMutationOptionsInput,
  ): Promise<CloudProjectAssignmentResponse> {
    const response = await this.execute<CloudProjectAssignmentResponse>("projectAssignments.set", {
      ...mutationOptions(request, options),
      pathParameters: { membershipId, projectId, teamId },
    });
    if (
      response.assignment.teamId !== teamId ||
      response.assignment.projectId !== projectId ||
      response.assignment.membershipId !== membershipId ||
      response.assignment.state !== request.desiredState
    ) {
      throw protocolError(
        "Cloud project-assignment response did not match the requested assignment.",
        response.requestId,
      );
    }
    return response;
  }

  public async listEligibleTeamProjectKeyRecipients(
    teamId: string,
    projectId: string,
    keyVersion: number,
    options: Pick<CloudTeamQueryOptionsInput, "signal"> = {},
  ): Promise<CloudTeamProjectKeyEligibleRecipientListResponse> {
    const response = await this.execute<CloudTeamProjectKeyEligibleRecipientListResponse>(
      "teamProjectKeyRecipients.list",
      {
        body: null,
        pathParameters: { keyVersion, projectId, teamId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (
      response.teamId !== teamId ||
      response.projectId !== projectId ||
      response.keyVersion !== keyVersion ||
      response.recipients.some(
        (recipient) =>
          recipient.teamId !== teamId ||
          recipient.projectId !== projectId ||
          recipient.keyVersion !== keyVersion,
      )
    ) {
      throw protocolError(
        "Cloud eligible-recipient response crossed its team, project or key-version scope.",
        response.requestId,
      );
    }
    return response;
  }

  public async getCurrentTeamProjectKeyMetadata(
    teamId: string,
    projectId: string,
    options: Pick<CloudTeamQueryOptionsInput, "signal"> = {},
  ): Promise<CloudTeamProjectCurrentKeyResponse> {
    const response = await this.execute<CloudTeamProjectCurrentKeyResponse>(
      "teamProjectKeys.getCurrent",
      {
        body: null,
        pathParameters: { projectId, teamId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (response.teamId !== teamId || response.projectId !== projectId) {
      throw protocolError(
        "Cloud current team-project key metadata crossed its team or project scope.",
        response.requestId,
      );
    }
    return response;
  }

  public async publishTeamProjectKeyEnvelope(
    teamId: string,
    projectId: string,
    keyVersion: number,
    request: CloudTeamProjectKeyEnvelopePublishRequest,
    options: CloudTeamMutationOptionsInput,
  ): Promise<CloudTeamProjectKeyEnvelopeResponse> {
    const response = await this.execute<CloudTeamProjectKeyEnvelopeResponse>(
      "teamProjectKeyEnvelopes.publish",
      {
        ...mutationOptions(request, options),
        pathParameters: { keyVersion, projectId, teamId },
        validateParsedBody: (body, requestId) => {
          assertTeamProjectKeyEnvelopeRouteScope(
            body as CloudTeamProjectKeyEnvelopePublishRequest,
            teamId,
            projectId,
            keyVersion,
            requestId,
            false,
          );
        },
      },
    );
    assertTeamProjectKeyEnvelopeRouteScope(
      response.envelope,
      teamId,
      projectId,
      keyVersion,
      response.requestId,
      true,
    );
    if (!isPublishedEnvelopeEcho(response.envelope, request)) {
      throw protocolError(
        "Cloud team-project envelope response did not match the published ciphertext and recipient snapshot.",
        response.requestId,
      );
    }
    return response;
  }

  public async getCurrentDeviceTeamProjectKeyEnvelope(
    teamId: string,
    projectId: string,
    keyVersion: number,
    currentDeviceId: string,
    options: Pick<CloudTeamQueryOptionsInput, "signal"> = {},
  ): Promise<CloudTeamProjectKeyEnvelopeResponse> {
    if (!UuidV7Schema.safeParse(currentDeviceId).success) {
      throw requestError("Current device must be a UUIDv7 identifier.");
    }
    const response = await this.execute<CloudTeamProjectKeyEnvelopeResponse>(
      "teamProjectKeyEnvelopes.getCurrentDevice",
      {
        body: null,
        pathParameters: { keyVersion, projectId, teamId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    assertTeamProjectKeyEnvelopeRouteScope(
      response.envelope,
      teamId,
      projectId,
      keyVersion,
      response.requestId,
      true,
    );
    if (response.envelope.recipientDeviceId !== currentDeviceId) {
      throw protocolError(
        "Cloud current-device envelope response contained another device's ciphertext.",
        response.requestId,
      );
    }
    return response;
  }
}

function mutationOptions(
  body: unknown,
  options: CloudTeamMutationOptionsInput,
): CloudTeamExecuteOptions {
  return {
    body,
    idempotencyKey: options.idempotencyKey,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function queryOptions(options: CloudTeamQueryOptionsInput): CloudTeamExecuteOptions {
  const cursor = normalizeCursor(options.cursor);
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_024)
  ) {
    throw requestError("Cloud pagination limit is outside the supported range.");
  }
  return {
    body: null,
    query: {
      cursor,
      limit: options.limit,
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function normalizeCursor(cursor: string | null | undefined): string | null | undefined {
  if (cursor === null || cursor === undefined) {
    return cursor;
  }
  const parsed = CloudCursorSchema.safeParse(cursor);
  if (!parsed.success) {
    throw requestError("Cloud pagination cursor is invalid.");
  }
  return parsed.data;
}

function redactSensitiveError(error: unknown, secret: string): unknown {
  if (secret.length === 0) {
    return error;
  }
  if (isCloudClientError(error)) {
    const message = redactSecret(error.message, secret);
    const supportId = redactNullableSecret(error.supportId, secret);
    const causeType = redactNullableSecret(error.causeType, secret);
    const actions = error.actions.map((action) => redactSecret(action, secret));
    if (
      message === error.message &&
      supportId === error.supportId &&
      causeType === error.causeType &&
      actions.every((action, index) => action === error.actions[index])
    ) {
      return error;
    }
    return new CloudClientError({
      code: error.code,
      message,
      status: error.status,
      requestId: error.requestId,
      retryable: error.retryable,
      actions,
      supportId,
      causeType,
    });
  }
  if (
    (typeof error === "string" && error.includes(secret)) ||
    (error instanceof Error && (error.message.includes(secret) || error.name.includes(secret)))
  ) {
    return new CloudClientError({
      code: "CLOUD_NETWORK_UNAVAILABLE",
      message: "The cloud invitation operation failed without exposing its credential.",
      status: null,
      requestId: null,
      retryable: true,
      actions: ["RETRY"],
      causeType: error instanceof Error ? redactSecret(error.name, secret) : "UnknownError",
    });
  }
  return error;
}

function redactSecret(value: string, secret: string): string {
  return value.replaceAll(secret, "[redacted]");
}

function redactNullableSecret(value: string | null, secret: string): string | null {
  return value === null ? null : redactSecret(value, secret);
}

function assertTeamProjectKeyEnvelopeRouteScope(
  envelope: CloudTeamProjectKeyEnvelopePublishRequest | CloudTeamProjectKeyEnvelope,
  teamId: string,
  projectId: string,
  keyVersion: number,
  requestId: string,
  remote: boolean,
): void {
  if (
    envelope.teamId !== teamId ||
    envelope.projectId !== projectId ||
    envelope.keyVersion !== keyVersion
  ) {
    if (remote) {
      throw protocolError(
        "Cloud team-project envelope response crossed its route scope.",
        requestId,
      );
    }
    throw requestError("Team-project envelope request does not match its route scope.", requestId);
  }
}

function isPublishedEnvelopeEcho(
  envelope: CloudTeamProjectKeyEnvelope,
  request: CloudTeamProjectKeyEnvelopePublishRequest,
): boolean {
  return (
    envelope.envelopeId === request.envelopeId &&
    envelope.teamId === request.teamId &&
    envelope.projectId === request.projectId &&
    envelope.keyVersion === request.keyVersion &&
    envelope.membershipId === request.membershipId &&
    envelope.membershipRevision === request.membershipRevision &&
    envelope.assignmentId === request.assignmentId &&
    envelope.assignmentRevision === request.assignmentRevision &&
    envelope.senderDeviceId === request.senderDeviceId &&
    envelope.senderPublicKey === request.senderPublicKey &&
    envelope.senderPublicKeyFingerprint === request.senderPublicKeyFingerprint &&
    envelope.recipientDeviceId === request.recipientDeviceId &&
    envelope.recipientPublicKey === request.recipientPublicKey &&
    envelope.recipientPublicKeyFingerprint === request.recipientPublicKeyFingerprint &&
    envelope.encapsulatedKey === request.encapsulatedKey &&
    envelope.ciphertext === request.ciphertext
  );
}

function requestError(message: string, requestId: string | null = null): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_REQUEST_INVALID",
    message,
    status: null,
    requestId,
    retryable: false,
  });
}

function protocolError(message: string, requestId: string): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    message,
    status: null,
    requestId,
    retryable: false,
    actions: ["RETRY", "CONTACT_SUPPORT"],
  });
}
