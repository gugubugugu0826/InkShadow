import {
  type CloudAccountDeletionCancellationRequest,
  type CloudAccountDeletionLookupRequest,
  type CloudAccountDeletionSubmissionRequest,
  type CloudAiProjectBudgetResponse,
  type CloudAiProjectBudgetUpdateRequest,
  type CloudAiTeamBudgetResponse,
  type CloudAiTeamBudgetUpdateRequest,
  type CloudAiUsageCancellationRequest,
  type CloudAiUsageEventListResponse,
  type CloudAiUsageReservationRequest,
  type CloudAiUsageReservationResponse,
  type CloudAiUsageSettlementRequest,
  type CloudAiUsageSummaryResponse,
  CloudApiErrorResponseSchema,
  CloudCursorSchema,
  CloudIdempotencyKeySchema,
  CloudOpaqueTokenSchema,
  UuidV7Schema,
  getCloudApiComponentSchema,
  getCloudApiOperation,
  type CloudApiComponentSchemaName,
  type CloudApiOperationId,
  type CloudAuthenticationRequest,
  type CloudDeletionCancellationRequest,
  type CloudDeletionRequestResponse,
  type CloudDeletionSubmissionRequest,
  type CloudDeviceListResponse,
  type CloudDeviceRegistrationRequest,
  type CloudDeviceResponse,
  type CloudEnterprisePolicyEvaluationRequest,
  type CloudEnterprisePolicyEvaluationResponse,
  type CloudEnterprisePolicyResponse,
  type CloudEnterprisePolicyUpdateRequest,
  type CloudEnterpriseSsoAuthorizationRequest,
  type CloudEnterpriseSsoAuthorizationResponse,
  type CloudEnterpriseSsoCallbackRequest,
  type CloudEnterpriseSsoSessionResponse,
  type CloudEnterpriseSsoStatusResponse,
  type CloudIdentityChallengeResponse,
  type CloudIdentityRegistrationRequest,
  type CloudIdentityVerificationRequest,
  type CloudMutationAcceptedResponse,
  type CloudPasswordResetConfirmationRequest,
  type CloudPasswordResetRequest,
  type CloudProjectAssignmentListResponse,
  type CloudProjectAssignmentResponse,
  type CloudProjectAssignmentSetRequest,
  type CloudProjectKeyPublishRequest,
  type CloudProjectKeyResponse,
  type CloudProjectStateResponse,
  type CloudReviewDecisionRequest,
  type CloudReviewListResponse,
  type CloudReviewResponse,
  type CloudReviewSubmissionRequest,
  type CloudReviewSuggestionDecisionRequest,
  type CloudReviewSuggestionDecisionResponse,
  type CloudReviewThreadItemAppendRequest,
  type CloudReviewThreadItemListResponse,
  type CloudReviewThreadItemResponse,
  type CloudReviewThreadListResponse,
  type CloudReviewThreadResolutionRequest,
  type CloudReviewThreadResponse,
  type CloudSessionGrantResponse,
  type CloudSessionListResponse,
  type CloudSessionLogoutRequest,
  type CloudSessionRefreshRequest,
  type CloudSyncPullResponse,
  type CloudSyncPushRequest,
  type CloudSyncPushResponse,
  type CloudSyncSnapshotResponse,
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
  type CloudTeamProjectKeyEnvelopePublishRequest,
  type CloudTeamProjectKeyEnvelopeResponse,
  type CloudTeamResponse,
  type CloudTeamTemplateApplicationResponse,
  type CloudTeamTemplateAad,
  type CloudTeamTemplateApplyRequest,
  type CloudTeamTemplateArchiveRequest,
  type CloudTeamTemplateCloneRequest,
  type CloudTeamTemplateCreateRequest,
  type CloudTeamTemplateListResponse,
  type CloudTeamTemplateMutationResponse,
  type CloudTeamTemplatePublishRequest,
  type CloudTeamTemplateResponse,
  type CloudTeamTemplateVersionCreateRequest,
  type CloudTeamTemplateVersion,
  type CloudTeamTemplateVersionListResponse,
  type CloudTeamTemplateVersionResponse,
  type CloudTombstoneAcknowledgementRequest,
} from "@inkshadow/contracts";

import { CloudClientError, isCloudClientError } from "./errors.js";
import { createMonotonicCloudRequestIdFactory, type CloudRequestIdFactory } from "./request-id.js";
import {
  CloudTeamClientDelegate,
  type CloudTeamExecuteOptions,
  type CloudTeamOperationId,
} from "./team-client.js";
import type { CloudHttpMethod, CloudTransport, CloudTransportResponse } from "./transport.js";

export interface CloudAccessTokenProvider {
  readAccessToken(): Promise<string | null>;
}

export interface CloudApiClientOptions {
  readonly transport: CloudTransport;
  readonly accessTokens?: CloudAccessTokenProvider;
  readonly requestIdFactory?: CloudRequestIdFactory;
}

export interface CloudMutationOptions {
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface CloudQueryOptions {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface CloudSyncPullOptions {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface CloudProjectStateOptions {
  readonly cursor?: string | null;
  readonly signal?: AbortSignal;
}

export interface CloudSyncSnapshotOptions {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

interface ExecuteOptions {
  readonly body: unknown;
  readonly idempotencyKey?: string;
  readonly pathParameters?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, string | number | null | undefined>>;
  readonly signal?: AbortSignal;
  readonly validateParsedBody?: (body: unknown, requestId: string) => void;
}

export class InkShadowCloudApiClient {
  private readonly transport: CloudTransport;
  private readonly accessTokens: CloudAccessTokenProvider | null;
  private readonly requestIdFactory: CloudRequestIdFactory;
  private readonly teamClient: CloudTeamClientDelegate;

  public constructor(options: CloudApiClientOptions) {
    this.transport = options.transport;
    this.accessTokens = options.accessTokens ?? null;
    this.requestIdFactory = options.requestIdFactory ?? createMonotonicCloudRequestIdFactory();
    this.teamClient = new CloudTeamClientDelegate(
      <Output>(operationId: CloudTeamOperationId, executeOptions: CloudTeamExecuteOptions) =>
        this.execute<Output>(operationId, executeOptions),
    );
  }

  public registerIdentity(
    request: CloudIdentityRegistrationRequest,
    options: CloudMutationOptions,
  ): Promise<CloudIdentityChallengeResponse> {
    return this.execute("identity.register", mutation(request, options));
  }

  public async verifyEmail(
    request: CloudIdentityVerificationRequest,
    options: CloudMutationOptions,
  ): Promise<CloudSessionGrantResponse> {
    const response = await this.execute<CloudSessionGrantResponse>(
      "identity.verifyEmail",
      mutation(request, options),
    );
    assertGrantDevice(response, request.device.deviceId);
    return response;
  }

  public requestPasswordReset(
    request: CloudPasswordResetRequest,
    options: CloudMutationOptions,
  ): Promise<CloudIdentityChallengeResponse> {
    return this.execute("identity.requestPasswordReset", mutation(request, options));
  }

  public confirmPasswordReset(
    request: CloudPasswordResetConfirmationRequest,
    options: CloudMutationOptions,
  ): Promise<CloudMutationAcceptedResponse> {
    return this.execute("identity.confirmPasswordReset", mutation(request, options));
  }

  public async login(
    request: CloudAuthenticationRequest,
    options: CloudMutationOptions,
  ): Promise<CloudSessionGrantResponse> {
    const response = await this.execute<CloudSessionGrantResponse>(
      "auth.login",
      mutation(request, options),
    );
    assertGrantDevice(response, request.device.deviceId);
    return response;
  }

  public async refresh(
    request: CloudSessionRefreshRequest,
    options: CloudMutationOptions,
  ): Promise<CloudSessionGrantResponse> {
    const response = await this.execute<CloudSessionGrantResponse>(
      "auth.refresh",
      mutation(request, options),
    );
    assertGrantDevice(response, request.deviceId);
    return response;
  }

  public logout(
    request: CloudSessionLogoutRequest,
    options: CloudMutationOptions,
  ): Promise<CloudMutationAcceptedResponse> {
    return this.execute("auth.logout", mutation(request, options));
  }

  public listSessions(options: CloudQueryOptions = {}): Promise<CloudSessionListResponse> {
    return this.execute("auth.listSessions", queryOptions(options));
  }

  public revokeSession(
    sessionId: string,
    options: CloudMutationOptions,
  ): Promise<CloudMutationAcceptedResponse> {
    return this.execute("auth.revokeSession", {
      body: null,
      idempotencyKey: options.idempotencyKey,
      pathParameters: { sessionId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  public listDevices(options: CloudQueryOptions = {}): Promise<CloudDeviceListResponse> {
    return this.execute("devices.list", queryOptions(options));
  }

  public async registerDevice(
    request: CloudDeviceRegistrationRequest,
    options: CloudMutationOptions,
  ): Promise<CloudDeviceResponse> {
    const response = await this.execute<CloudDeviceResponse>(
      "devices.register",
      mutation(request, options),
    );
    assertDeviceResponse(response, request.device.deviceId);
    return response;
  }

  public async revokeDevice(
    deviceId: string,
    options: CloudMutationOptions,
  ): Promise<CloudDeviceResponse> {
    const response = await this.execute<CloudDeviceResponse>("devices.revoke", {
      body: null,
      idempotencyKey: options.idempotencyKey,
      pathParameters: { deviceId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertDeviceResponse(response, deviceId);
    if (response.device.device.state !== "revoked") {
      throw protocolError(
        "Cloud device revocation response did not contain a revoked device.",
        response.requestId,
      );
    }
    return response;
  }

  public createTeam(
    request: CloudTeamCreateRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamResponse> {
    return this.teamClient.createTeam(request, options);
  }

  public listTeams(options: CloudQueryOptions = {}): Promise<CloudTeamListResponse> {
    return this.teamClient.listTeams(options);
  }

  public listTeamMembers(
    teamId: string,
    options: CloudQueryOptions = {},
  ): Promise<CloudTeamMemberListResponse> {
    return this.teamClient.listTeamMembers(teamId, options);
  }

  public createTeamInvitation(
    teamId: string,
    request: CloudTeamInvitationCreateRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamInvitationResponse> {
    return this.teamClient.createTeamInvitation(teamId, request, options);
  }

  public acceptTeamInvitation(
    invitationId: string,
    request: CloudTeamInvitationAcceptRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamInvitationAcceptanceResponse> {
    return this.teamClient.acceptTeamInvitation(invitationId, request, options);
  }

  public changeTeamMemberRole(
    teamId: string,
    membershipId: string,
    request: CloudTeamMemberRoleChangeRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamMembershipResponse> {
    return this.teamClient.changeTeamMemberRole(teamId, membershipId, request, options);
  }

  public revokeTeamMembership(
    teamId: string,
    membershipId: string,
    request: CloudTeamMembershipRevokeRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamMembershipResponse> {
    return this.teamClient.revokeTeamMembership(teamId, membershipId, request, options);
  }

  public listProjectAssignments(
    teamId: string,
    projectId: string,
    options: CloudQueryOptions = {},
  ): Promise<CloudProjectAssignmentListResponse> {
    return this.teamClient.listProjectAssignments(teamId, projectId, options);
  }

  public setProjectAssignment(
    teamId: string,
    projectId: string,
    membershipId: string,
    request: CloudProjectAssignmentSetRequest,
    options: CloudMutationOptions,
  ): Promise<CloudProjectAssignmentResponse> {
    return this.teamClient.setProjectAssignment(teamId, projectId, membershipId, request, options);
  }

  public async getEnterprisePolicy(
    teamId: string,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudEnterprisePolicyResponse> {
    const response = await this.execute<CloudEnterprisePolicyResponse>("enterprisePolicies.get", {
      body: null,
      pathParameters: { teamId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertEnterprisePolicyScope(response, teamId);
    return response;
  }

  public async updateEnterprisePolicy(
    teamId: string,
    request: CloudEnterprisePolicyUpdateRequest,
    options: CloudMutationOptions,
  ): Promise<CloudEnterprisePolicyResponse> {
    const response = await this.execute<CloudEnterprisePolicyResponse>(
      "enterprisePolicies.update",
      {
        ...mutation(request, options),
        pathParameters: { teamId },
      },
    );
    assertEnterprisePolicyScope(response, teamId);
    return response;
  }

  public async evaluateEnterprisePolicy(
    teamId: string,
    request: CloudEnterprisePolicyEvaluationRequest,
    options: CloudMutationOptions,
  ): Promise<CloudEnterprisePolicyEvaluationResponse> {
    const response = await this.execute<CloudEnterprisePolicyEvaluationResponse>(
      "enterprisePolicies.evaluate",
      {
        ...mutation(request, options),
        pathParameters: { teamId },
      },
    );
    if (response.teamId !== teamId || response.action !== request.action) {
      throw protocolError(
        "Enterprise policy evaluation crossed its requested scope.",
        response.requestId,
      );
    }
    return response;
  }

  public async getEnterpriseSsoStatus(
    teamId: string,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudEnterpriseSsoStatusResponse> {
    const response = await this.execute<CloudEnterpriseSsoStatusResponse>(
      "enterpriseSso.getStatus",
      {
        body: null,
        pathParameters: { teamId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (response.teamId !== teamId) {
      throw protocolError("Enterprise SSO status crossed its requested scope.", response.requestId);
    }
    return response;
  }

  public async authorizeEnterpriseSso(
    request: CloudEnterpriseSsoAuthorizationRequest,
    options: CloudMutationOptions,
  ): Promise<CloudEnterpriseSsoAuthorizationResponse> {
    const response = await this.execute<CloudEnterpriseSsoAuthorizationResponse>(
      "enterpriseSso.authorize",
      mutation(request, options),
    );
    if (response.teamId !== request.teamId) {
      throw protocolError(
        "Enterprise SSO authorization crossed its requested team scope.",
        response.requestId,
      );
    }
    return response;
  }

  public async completeEnterpriseSso(
    request: CloudEnterpriseSsoCallbackRequest,
    options: CloudMutationOptions,
  ): Promise<CloudEnterpriseSsoSessionResponse> {
    const response = await this.execute<CloudEnterpriseSsoSessionResponse>(
      "enterpriseSso.complete",
      mutation(request, options),
    );
    assertGrantDevice(response, request.device.deviceId);
    return response;
  }

  public async createTeamTemplate(
    teamId: string,
    projectId: string,
    request: CloudTeamTemplateCreateRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateMutationResponse> {
    assertTemplateWriteScope(request.payload.aad, teamId, projectId, request.templateId, null);
    const response = await this.execute<CloudTeamTemplateMutationResponse>("teamTemplates.create", {
      ...mutation(request, options),
      pathParameters: { projectId, teamId },
    });
    assertTemplateMutationResponseScope(
      response,
      teamId,
      projectId,
      request.templateId,
      request.versionId,
    );
    return response;
  }

  public async listTeamTemplates(
    teamId: string,
    projectId: string,
    options: CloudQueryOptions = {},
  ): Promise<CloudTeamTemplateListResponse> {
    const response = await this.execute<CloudTeamTemplateListResponse>("teamTemplates.list", {
      ...queryOptions(options),
      pathParameters: { projectId, teamId },
    });
    if (
      response.templates.some(
        (template) => template.teamId !== teamId || template.projectId !== projectId,
      )
    ) {
      throw protocolError("Cloud team-template list crossed its route scope.", response.requestId);
    }
    return response;
  }

  public async getTeamTemplate(
    teamId: string,
    projectId: string,
    templateId: string,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudTeamTemplateResponse> {
    const response = await this.execute<CloudTeamTemplateResponse>("teamTemplates.get", {
      body: null,
      pathParameters: { projectId, teamId, templateId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertTemplateResponseScope(response, teamId, projectId, templateId);
    return response;
  }

  public async createTeamTemplateVersion(
    teamId: string,
    projectId: string,
    templateId: string,
    request: CloudTeamTemplateVersionCreateRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateMutationResponse> {
    assertTemplateWriteScope(request.payload.aad, teamId, projectId, templateId, request.versionId);
    const response = await this.execute<CloudTeamTemplateMutationResponse>(
      "teamTemplateVersions.create",
      {
        ...mutation(request, options),
        pathParameters: { projectId, teamId, templateId },
      },
    );
    assertTemplateMutationResponseScope(response, teamId, projectId, templateId, request.versionId);
    return response;
  }

  public async listTeamTemplateVersions(
    teamId: string,
    projectId: string,
    templateId: string,
    options: CloudQueryOptions = {},
  ): Promise<CloudTeamTemplateVersionListResponse> {
    const response = await this.execute<CloudTeamTemplateVersionListResponse>(
      "teamTemplateVersions.list",
      {
        ...queryOptions(options),
        pathParameters: { projectId, teamId, templateId },
      },
    );
    if (
      response.versions.some(
        (version) =>
          version.teamId !== teamId ||
          version.projectId !== projectId ||
          version.templateId !== templateId,
      )
    ) {
      throw protocolError(
        "Cloud team-template version list crossed its route scope.",
        response.requestId,
      );
    }
    return response;
  }

  public async getTeamTemplateVersion(
    teamId: string,
    projectId: string,
    templateId: string,
    versionId: string,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudTeamTemplateVersionResponse> {
    const response = await this.execute<CloudTeamTemplateVersionResponse>(
      "teamTemplateVersions.get",
      {
        body: null,
        pathParameters: { projectId, teamId, templateId, versionId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    assertTemplateVersionScope(
      response.version,
      teamId,
      projectId,
      templateId,
      versionId,
      response.requestId,
    );
    return response;
  }

  public async cloneTeamTemplate(
    teamId: string,
    projectId: string,
    sourceTemplateId: string,
    request: CloudTeamTemplateCloneRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateMutationResponse> {
    assertTemplateWriteScope(
      request.payload.aad,
      teamId,
      projectId,
      request.targetTemplateId,
      request.versionId,
    );
    const response = await this.execute<CloudTeamTemplateMutationResponse>("teamTemplates.clone", {
      ...mutation(request, options),
      pathParameters: { projectId, teamId, templateId: sourceTemplateId },
    });
    assertTemplateMutationResponseScope(
      response,
      teamId,
      projectId,
      request.targetTemplateId,
      request.versionId,
    );
    return response;
  }

  public async publishTeamTemplate(
    teamId: string,
    projectId: string,
    templateId: string,
    request: CloudTeamTemplatePublishRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateResponse> {
    const response = await this.execute<CloudTeamTemplateResponse>("teamTemplates.publish", {
      ...mutation(request, options),
      pathParameters: { projectId, teamId, templateId },
    });
    assertTemplateResponseScope(response, teamId, projectId, templateId);
    if (
      response.template.state !== "published" ||
      response.template.publishedVersionNumber === null
    ) {
      throw protocolError(
        "Cloud team-template publication returned a non-published resource.",
        response.requestId,
      );
    }
    return response;
  }

  public async archiveTeamTemplate(
    teamId: string,
    projectId: string,
    templateId: string,
    request: CloudTeamTemplateArchiveRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateResponse> {
    const response = await this.execute<CloudTeamTemplateResponse>("teamTemplates.archive", {
      ...mutation(request, options),
      pathParameters: { projectId, teamId, templateId },
    });
    assertTemplateResponseScope(response, teamId, projectId, templateId);
    if (response.template.state !== "archived") {
      throw protocolError(
        "Cloud team-template archival returned a non-archived resource.",
        response.requestId,
      );
    }
    return response;
  }

  public async recordTeamTemplateApplication(
    teamId: string,
    projectId: string,
    templateId: string,
    request: CloudTeamTemplateApplyRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateApplicationResponse> {
    const response = await this.execute<CloudTeamTemplateApplicationResponse>(
      "teamTemplateApplications.record",
      {
        ...mutation(request, options),
        pathParameters: { projectId, teamId, templateId },
      },
    );
    if (
      response.teamId !== teamId ||
      response.projectId !== projectId ||
      response.templateId !== templateId ||
      response.versionId !== request.versionId ||
      response.applicationId !== request.applicationId
    ) {
      throw protocolError(
        "Cloud team-template application receipt crossed its route scope.",
        response.requestId,
      );
    }
    return response;
  }

  public listEligibleTeamProjectKeyRecipients(
    teamId: string,
    projectId: string,
    keyVersion: number,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudTeamProjectKeyEligibleRecipientListResponse> {
    return this.teamClient.listEligibleTeamProjectKeyRecipients(
      teamId,
      projectId,
      keyVersion,
      options,
    );
  }

  public getCurrentTeamProjectKeyMetadata(
    teamId: string,
    projectId: string,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudTeamProjectCurrentKeyResponse> {
    return this.teamClient.getCurrentTeamProjectKeyMetadata(teamId, projectId, options);
  }

  public publishTeamProjectKeyEnvelope(
    teamId: string,
    projectId: string,
    keyVersion: number,
    request: CloudTeamProjectKeyEnvelopePublishRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamProjectKeyEnvelopeResponse> {
    return this.teamClient.publishTeamProjectKeyEnvelope(
      teamId,
      projectId,
      keyVersion,
      request,
      options,
    );
  }

  public getCurrentDeviceTeamProjectKeyEnvelope(
    teamId: string,
    projectId: string,
    keyVersion: number,
    currentDeviceId: string,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudTeamProjectKeyEnvelopeResponse> {
    return this.teamClient.getCurrentDeviceTeamProjectKeyEnvelope(
      teamId,
      projectId,
      keyVersion,
      currentDeviceId,
      options,
    );
  }

  public async updateTeamAiBudget(
    teamId: string,
    request: CloudAiTeamBudgetUpdateRequest,
    options: CloudMutationOptions,
  ): Promise<CloudAiTeamBudgetResponse> {
    const response = await this.execute<CloudAiTeamBudgetResponse>("aiBudgets.updateTeam", {
      ...mutation(request, options),
      pathParameters: { teamId },
    });
    if (response.budget.teamId !== teamId) {
      throw protocolError("Cloud AI team budget crossed its team scope.", response.requestId);
    }
    return response;
  }

  public async updateProjectAiBudget(
    teamId: string,
    projectId: string,
    request: CloudAiProjectBudgetUpdateRequest,
    options: CloudMutationOptions,
  ): Promise<CloudAiProjectBudgetResponse> {
    const response = await this.execute<CloudAiProjectBudgetResponse>("aiBudgets.updateProject", {
      ...mutation(request, options),
      pathParameters: { projectId, teamId },
    });
    if (response.budget.teamId !== teamId || response.budget.projectId !== projectId) {
      throw protocolError(
        "Cloud AI project budget crossed its team or project scope.",
        response.requestId,
      );
    }
    return response;
  }

  public async getTeamAiUsageSummary(
    teamId: string,
    projectId: string | null = null,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudAiUsageSummaryResponse> {
    const response = await this.execute<CloudAiUsageSummaryResponse>("aiUsage.getSummary", {
      body: null,
      pathParameters: { teamId },
      query: { projectId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertAiUsageSummaryScope(response, teamId, projectId);
    return response;
  }

  public async listTeamAiUsageEvents(
    teamId: string,
    projectId: string | null = null,
    options: CloudQueryOptions = {},
  ): Promise<CloudAiUsageEventListResponse> {
    const cursor =
      options.cursor === null || options.cursor === undefined
        ? options.cursor
        : CloudCursorSchema.parse(options.cursor);
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)
    ) {
      throw requestError("AI usage event page size is outside the supported range.", null);
    }
    const response = await this.execute<CloudAiUsageEventListResponse>("aiUsage.listEvents", {
      body: null,
      pathParameters: { teamId },
      query: { cursor, limit: options.limit, projectId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (
      response.teamId !== teamId ||
      response.projectId !== projectId ||
      response.events.some(
        (event) => event.teamId !== teamId || (projectId !== null && event.projectId !== projectId),
      )
    ) {
      throw protocolError(
        "Cloud AI usage events crossed their requested scope.",
        response.requestId,
      );
    }
    return response;
  }

  public async reserveTeamProjectAiUsage(
    teamId: string,
    projectId: string,
    request: CloudAiUsageReservationRequest,
    options: CloudMutationOptions,
  ): Promise<CloudAiUsageReservationResponse> {
    const response = await this.execute<CloudAiUsageReservationResponse>("aiUsage.reserve", {
      ...mutation(request, options),
      pathParameters: { projectId, teamId },
    });
    assertAiReservationScope(response, teamId, projectId, request.reservationId);
    return response;
  }

  public async settleTeamProjectAiUsage(
    teamId: string,
    projectId: string,
    reservationId: string,
    request: CloudAiUsageSettlementRequest,
    options: CloudMutationOptions,
  ): Promise<CloudAiUsageReservationResponse> {
    const response = await this.execute<CloudAiUsageReservationResponse>("aiUsage.settle", {
      ...mutation(request, options),
      pathParameters: { projectId, reservationId, teamId },
    });
    assertAiReservationScope(response, teamId, projectId, reservationId);
    return response;
  }

  public async cancelTeamProjectAiUsage(
    teamId: string,
    projectId: string,
    reservationId: string,
    request: CloudAiUsageCancellationRequest,
    options: CloudMutationOptions,
  ): Promise<CloudAiUsageReservationResponse> {
    const response = await this.execute<CloudAiUsageReservationResponse>("aiUsage.cancel", {
      ...mutation(request, options),
      pathParameters: { projectId, reservationId, teamId },
    });
    assertAiReservationScope(response, teamId, projectId, reservationId);
    return response;
  }

  public async submitReview(
    teamId: string,
    projectId: string,
    request: CloudReviewSubmissionRequest,
    options: CloudMutationOptions,
  ): Promise<CloudReviewResponse> {
    if (request.teamId !== teamId || request.projectId !== projectId) {
      throw requestError("Review submission scope does not match its route.", null);
    }
    const response = await this.execute<CloudReviewResponse>("reviews.submit", {
      body: request,
      idempotencyKey: options.idempotencyKey,
      pathParameters: { projectId, teamId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertReviewScope(response, teamId, projectId, request.reviewId);
    return response;
  }

  public async listReviews(
    teamId: string,
    projectId: string,
    options: CloudQueryOptions = {},
  ): Promise<CloudReviewListResponse> {
    const response = await this.execute<CloudReviewListResponse>("reviews.list", {
      body: null,
      pathParameters: { projectId, teamId },
      query: normalizeReviewQuery(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (
      response.reviews.some((review) => review.teamId !== teamId || review.projectId !== projectId)
    ) {
      throw protocolError(
        "Cloud review list crossed its team or project scope.",
        response.requestId,
      );
    }
    return response;
  }

  public async getReview(
    teamId: string,
    projectId: string,
    reviewId: string,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudReviewResponse> {
    const response = await this.execute<CloudReviewResponse>("reviews.get", {
      body: null,
      pathParameters: { projectId, reviewId, teamId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertReviewScope(response, teamId, projectId, reviewId);
    return response;
  }

  public async decideReview(
    teamId: string,
    projectId: string,
    reviewId: string,
    request: CloudReviewDecisionRequest,
    options: CloudMutationOptions,
  ): Promise<CloudReviewResponse> {
    const response = await this.execute<CloudReviewResponse>("reviewDecisions.create", {
      body: request,
      idempotencyKey: options.idempotencyKey,
      pathParameters: { projectId, reviewId, teamId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertReviewScope(response, teamId, projectId, reviewId);
    if (response.review.state !== request.decision) {
      throw protocolError(
        "Cloud review decision did not match the requested state.",
        response.requestId,
      );
    }
    return response;
  }

  public async appendReviewThreadItem(
    teamId: string,
    projectId: string,
    reviewId: string,
    request: CloudReviewThreadItemAppendRequest,
    options: CloudMutationOptions,
  ): Promise<CloudReviewThreadItemResponse> {
    const response = await this.execute<CloudReviewThreadItemResponse>("reviewThreadItems.append", {
      body: request,
      idempotencyKey: options.idempotencyKey,
      pathParameters: { projectId, reviewId, teamId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertThreadItemScope(response, teamId, projectId, reviewId, request.threadId, request.itemId);
    return response;
  }

  public async listReviewThreadItems(
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    options: CloudQueryOptions = {},
  ): Promise<CloudReviewThreadItemListResponse> {
    const response = await this.execute<CloudReviewThreadItemListResponse>(
      "reviewThreadItems.list",
      {
        body: null,
        pathParameters: { projectId, reviewId, teamId, threadId },
        query: normalizeReviewQuery(options),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (
      response.thread.teamId !== teamId ||
      response.thread.projectId !== projectId ||
      response.thread.reviewId !== reviewId ||
      response.thread.threadId !== threadId ||
      response.items.some(
        (item) =>
          item.teamId !== teamId ||
          item.projectId !== projectId ||
          item.reviewId !== reviewId ||
          item.threadId !== threadId,
      )
    ) {
      throw protocolError(
        "Cloud review-thread item page crossed its route scope.",
        response.requestId,
      );
    }
    return response;
  }

  public async listReviewThreads(
    teamId: string,
    projectId: string,
    reviewId: string,
    options: CloudQueryOptions = {},
  ): Promise<CloudReviewThreadListResponse> {
    const response = await this.execute<CloudReviewThreadListResponse>("reviewThreads.list", {
      body: null,
      pathParameters: { projectId, reviewId, teamId },
      query: normalizeReviewQuery(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (
      response.threads.some(
        (thread) =>
          thread.teamId !== teamId ||
          thread.projectId !== projectId ||
          thread.reviewId !== reviewId,
      )
    ) {
      throw protocolError("Cloud review-thread list crossed its route scope.", response.requestId);
    }
    return response;
  }

  public async resolveReviewThread(
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    request: CloudReviewThreadResolutionRequest,
    options: CloudMutationOptions,
  ): Promise<CloudReviewThreadResponse> {
    const response = await this.execute<CloudReviewThreadResponse>("reviewThreads.resolve", {
      body: request,
      idempotencyKey: options.idempotencyKey,
      pathParameters: { projectId, reviewId, teamId, threadId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertThreadScope(response.thread, teamId, projectId, reviewId, threadId, response.requestId);
    if (response.thread.state !== "resolved") {
      throw protocolError(
        "Cloud review-thread resolution did not return a resolved thread.",
        response.requestId,
      );
    }
    return response;
  }

  public async decideReviewSuggestion(
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    itemId: string,
    request: CloudReviewSuggestionDecisionRequest,
    options: CloudMutationOptions,
  ): Promise<CloudReviewSuggestionDecisionResponse> {
    const response = await this.execute<CloudReviewSuggestionDecisionResponse>(
      "reviewSuggestionDecisions.create",
      {
        body: request,
        idempotencyKey: options.idempotencyKey,
        pathParameters: { itemId, projectId, reviewId, teamId, threadId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    assertThreadItemScope(response, teamId, projectId, reviewId, threadId, itemId);
    if (response.item.suggestionDecision !== request.decision) {
      throw protocolError(
        "Cloud suggestion decision violated its metadata-only contract.",
        response.requestId,
      );
    }
    return response;
  }

  public async requestProjectDeletion(
    projectId: string,
    request: CloudDeletionSubmissionRequest,
    options: CloudMutationOptions,
  ): Promise<CloudDeletionRequestResponse> {
    const response = await this.execute<CloudDeletionRequestResponse>("projectDeletions.request", {
      body: request,
      idempotencyKey: options.idempotencyKey,
      pathParameters: { projectId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertDeletionResponseScope(response, "project", projectId);
    return response;
  }

  public async getProjectDeletionRequest(
    projectId: string,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudDeletionRequestResponse> {
    const response = await this.execute<CloudDeletionRequestResponse>("projectDeletions.get", {
      body: null,
      pathParameters: { projectId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertDeletionResponseScope(response, "project", projectId);
    return response;
  }

  public async cancelProjectDeletion(
    projectId: string,
    request: CloudDeletionCancellationRequest,
    options: CloudMutationOptions,
  ): Promise<CloudDeletionRequestResponse> {
    const response = await this.execute<CloudDeletionRequestResponse>("projectDeletions.cancel", {
      body: request,
      idempotencyKey: options.idempotencyKey,
      pathParameters: { projectId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertDeletionResponseScope(response, "project", projectId, request.deletionRequestId);
    assertCancelledDeletion(response);
    return response;
  }

  public async requestAccountDeletion(
    request: CloudAccountDeletionSubmissionRequest,
    options: CloudMutationOptions,
  ): Promise<CloudDeletionRequestResponse> {
    const response = await this.execute<CloudDeletionRequestResponse>(
      "accountDeletions.request",
      mutation(request, options),
    );
    assertDeletionResponseScope(response, "account");
    return response;
  }

  public async lookupAccountDeletion(
    request: CloudAccountDeletionLookupRequest,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudDeletionRequestResponse> {
    const response = await this.execute<CloudDeletionRequestResponse>("accountDeletions.lookup", {
      body: request,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertDeletionResponseScope(
      response,
      "account",
      undefined,
      "deletionRequestId" in request ? request.deletionRequestId : undefined,
    );
    return response;
  }

  public async cancelAccountDeletion(
    request: CloudAccountDeletionCancellationRequest,
    options: CloudMutationOptions,
  ): Promise<CloudDeletionRequestResponse> {
    const response = await this.execute<CloudDeletionRequestResponse>(
      "accountDeletions.cancel",
      mutation(request, options),
    );
    assertDeletionResponseScope(response, "account", undefined, request.deletionRequestId);
    assertCancelledDeletion(response);
    return response;
  }

  public async publishProjectKeys(
    projectId: string,
    keyVersion: number,
    request: CloudProjectKeyPublishRequest,
    options: CloudMutationOptions,
  ): Promise<CloudProjectKeyResponse> {
    const response = await this.execute<CloudProjectKeyResponse>("projectKeys.publish", {
      body: request,
      idempotencyKey: options.idempotencyKey,
      pathParameters: { projectId, keyVersion },
      validateParsedBody: (body, requestId) => {
        assertProjectKeyRequestScope(
          body as CloudProjectKeyPublishRequest,
          projectId,
          keyVersion,
          requestId,
        );
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertProjectKeyResponseScope(response, projectId, keyVersion);
    return response;
  }

  public async getProjectKeys(
    projectId: string,
    keyVersion: number,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudProjectKeyResponse> {
    const response = await this.execute<CloudProjectKeyResponse>("projectKeys.get", {
      body: null,
      pathParameters: { projectId, keyVersion },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertProjectKeyResponseScope(response, projectId, keyVersion);
    return response;
  }

  public async getCurrentProjectKeys(
    projectId: string,
    options: Pick<CloudQueryOptions, "signal"> = {},
  ): Promise<CloudProjectKeyResponse> {
    const response = await this.execute<CloudProjectKeyResponse>("projectKeys.getCurrent", {
      body: null,
      pathParameters: { projectId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertProjectKeyResponseScope(response, projectId, response.keySet.keyVersion);
    if (response.keySet.version.state !== "active") {
      throw protocolError(
        "Current cloud project-key response did not contain an active version.",
        response.requestId,
      );
    }
    return response;
  }

  public async getProjectState(
    projectId: string,
    options: CloudProjectStateOptions = {},
  ): Promise<CloudProjectStateResponse> {
    const response = await this.execute<CloudProjectStateResponse>("projects.getState", {
      body: null,
      pathParameters: { projectId },
      query: {
        cursor: normalizeCursor(options.cursor),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.project.projectId !== projectId) {
      throw protocolError(
        "Cloud project-state response does not match its route scope.",
        response.requestId,
      );
    }
    return response;
  }

  public async pushSync(
    projectId: string,
    request: CloudSyncPushRequest,
    options: CloudMutationOptions,
  ): Promise<CloudSyncPushResponse> {
    const response = await this.execute<CloudSyncPushResponse>("sync.push", {
      body: request,
      idempotencyKey: options.idempotencyKey,
      pathParameters: { projectId },
      validateParsedBody: (body, requestId) => {
        assertSyncPushScope(body as CloudSyncPushRequest, projectId, false, requestId);
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const accepted = new Set(response.acceptedOperations.map((item) => item.operationId));
    if (
      accepted.size !== request.operations.length ||
      request.operations.some((operation) => !accepted.has(operation.operationId))
    ) {
      throw protocolError(
        "Cloud sync response did not acknowledge the exact operation batch.",
        response.requestId,
      );
    }
    return response;
  }

  public async pullSync(
    projectId: string,
    options: CloudSyncPullOptions = {},
  ): Promise<CloudSyncPullResponse> {
    const response = await this.execute<CloudSyncPullResponse>("sync.pull", {
      body: null,
      pathParameters: { projectId },
      query: normalizeQuery(options, 256),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertSyncPushScope(response, projectId, true, response.requestId);
    return response;
  }

  public async getSyncSnapshot(
    projectId: string,
    options: CloudSyncSnapshotOptions = {},
  ): Promise<CloudSyncSnapshotResponse> {
    const response = await this.execute<CloudSyncSnapshotResponse>("sync.snapshot", {
      body: null,
      pathParameters: { projectId },
      query: normalizeQuery(options, 256),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    assertSyncSnapshotResponse(response, projectId);
    return response;
  }

  public acknowledgeTombstones(
    projectId: string,
    request: CloudTombstoneAcknowledgementRequest,
    options: CloudMutationOptions,
  ): Promise<CloudMutationAcceptedResponse> {
    return this.execute("sync.acknowledgeTombstones", {
      body: request,
      idempotencyKey: options.idempotencyKey,
      pathParameters: { projectId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private async execute<Output>(
    operationId: CloudApiOperationId,
    options: ExecuteOptions,
  ): Promise<Output> {
    const operation = getCloudApiOperation(operationId);
    const requestId = this.requireRequestId(this.requestIdFactory());
    if (
      operation.requiresNativePasswordBoundary &&
      this.transport.handlesNativePasswordBoundary !== true
    ) {
      throw requestError(
        "This cloud operation requires a dedicated native password boundary.",
        requestId,
      );
    }
    const body = parseRequestBody(operation.requestSchemaName, options.body, requestId);
    options.validateParsedBody?.(body, requestId);
    const path = buildPath(operation.path, options.pathParameters ?? {}, requestId);
    const query = buildQuery(options.query ?? {}, requestId);
    const headers: Record<string, string> = {
      "X-Request-Id": requestId,
    };
    if (operation.requiresIdempotencyKey) {
      const parsed = CloudIdempotencyKeySchema.safeParse(options.idempotencyKey);
      if (!parsed.success) {
        throw requestError(
          "This cloud mutation requires a stable, bounded idempotency key.",
          requestId,
        );
      }
      headers["Idempotency-Key"] = parsed.data;
    } else if (options.idempotencyKey !== undefined) {
      throw requestError("Read-only cloud requests do not accept idempotency keys.", requestId);
    }
    if (operation.requiresAuthentication && this.transport.handlesSessionAuthentication !== true) {
      headers.Authorization = `Bearer ${await this.readAccessToken(requestId)}`;
    }

    let response: CloudTransportResponse;
    try {
      response = await this.transport.send({
        method: operation.method.toUpperCase() as CloudHttpMethod,
        path: `${path}${query}`,
        authentication: operation.requiresAuthentication ? "session" : "none",
        headers,
        body,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause: unknown) {
      if (isCloudClientError(cause)) {
        throw cause;
      }
      throw new CloudClientError({
        code: "CLOUD_NETWORK_UNAVAILABLE",
        message: "The cloud service could not be reached.",
        status: null,
        requestId,
        retryable: true,
        actions: ["RETRY", "USE_LOCAL"],
        causeType: cause instanceof Error ? cause.name : "UnknownError",
      });
    }

    if (response.status !== operation.successStatus) {
      throw parseServerError(response, requestId);
    }
    const responseRequestId = response.headers["x-request-id"];
    if (responseRequestId !== undefined && responseRequestId !== requestId) {
      throw protocolError("Cloud response request correlation did not match.", requestId);
    }
    const parsed = getCloudApiComponentSchema(operation.successSchemaName).safeParse(response.body);
    if (!parsed.success || !hasMatchingRequestId(parsed.data, requestId)) {
      throw protocolError("Cloud response violated its published contract.", requestId);
    }
    return parsed.data as Output;
  }

  private requireRequestId(value: string): string {
    const parsed = UuidV7Schema.safeParse(value);
    if (!parsed.success) {
      throw new CloudClientError({
        code: "CLOUD_CONFIGURATION_INVALID",
        message: "Cloud request-id generation violated the UUIDv7 contract.",
        status: null,
        requestId: null,
        retryable: false,
      });
    }
    return parsed.data;
  }

  private async readAccessToken(requestId: string): Promise<string> {
    if (this.accessTokens === null) {
      throw authenticationRequired(requestId, null);
    }
    let value: string | null;
    try {
      value = await this.accessTokens.readAccessToken();
    } catch (cause: unknown) {
      throw authenticationRequired(requestId, cause instanceof Error ? cause.name : "UnknownError");
    }
    const parsed = CloudOpaqueTokenSchema.safeParse(value);
    if (!parsed.success) {
      throw authenticationRequired(requestId, null);
    }
    return parsed.data;
  }
}

function mutation(body: unknown, options: CloudMutationOptions): ExecuteOptions {
  return {
    body,
    idempotencyKey: options.idempotencyKey,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function queryOptions(options: CloudQueryOptions): ExecuteOptions {
  return {
    body: null,
    query: normalizeQuery(options, 1_024),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function normalizeQuery(
  options: CloudQueryOptions | CloudSyncPullOptions | CloudSyncSnapshotOptions,
  maximumLimit: number,
): Readonly<Record<string, string | number | null | undefined>> {
  const cursor = normalizeCursor(options.cursor);
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > maximumLimit)
  ) {
    throw requestError("Cloud pagination limit is outside the supported range.", null);
  }
  return {
    cursor,
    limit: options.limit,
  };
}

function normalizeReviewQuery(
  options: CloudQueryOptions,
): Readonly<Record<string, string | number | null | undefined>> {
  return normalizeQuery(options, 100);
}

function normalizeCursor(cursor: string | null | undefined): string | null | undefined {
  if (cursor === null || cursor === undefined) {
    return cursor;
  }
  const parsed = CloudCursorSchema.safeParse(cursor);
  if (!parsed.success) {
    throw requestError("Cloud pagination cursor is invalid.", null);
  }
  return parsed.data;
}

function parseRequestBody(
  schemaName: CloudApiComponentSchemaName | null,
  body: unknown,
  requestId: string,
): unknown {
  if (schemaName === null) {
    if (body !== null) {
      throw requestError("This cloud operation does not accept a request body.", requestId);
    }
    return null;
  }
  const parsed = getCloudApiComponentSchema(schemaName).safeParse(body);
  if (!parsed.success) {
    throw requestError("Cloud request violated its published contract.", requestId);
  }
  return parsed.data;
}

function buildPath(
  template: string,
  parameters: Readonly<Record<string, string | number>>,
  requestId: string,
): string {
  const requiredNames = [...template.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1] ?? "");
  if (
    requiredNames.length !== Object.keys(parameters).length ||
    requiredNames.some((name) => !(name in parameters))
  ) {
    throw requestError("Cloud route parameters are incomplete or unexpected.", requestId);
  }
  return requiredNames.reduce((path, name) => {
    const value = parameters[name];
    if (name === "keyVersion") {
      if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) {
        throw requestError("Project key version is invalid.", requestId);
      }
    } else if (!UuidV7Schema.safeParse(value).success) {
      throw requestError(`${name} must be a UUIDv7 identifier.`, requestId);
    }
    return path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }, template);
}

function buildQuery(
  query: Readonly<Record<string, string | number | null | undefined>>,
  requestId: string,
): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(query).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (value === null || value === undefined) {
      continue;
    }
    if (!/^[a-z][A-Za-z0-9]*$/u.test(name)) {
      throw requestError("Cloud query parameter name is invalid.", requestId);
    }
    parameters.set(name, String(value));
  }
  const serialized = parameters.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

function parseServerError(response: CloudTransportResponse, requestId: string): CloudClientError {
  const parsed = CloudApiErrorResponseSchema.safeParse(response.body);
  if (!parsed.success || parsed.data.requestId !== requestId) {
    return protocolError("Cloud error response violated its published contract.", requestId);
  }
  return new CloudClientError({
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    status: response.status,
    requestId,
    retryable: parsed.data.error.retryable,
    actions: parsed.data.error.actions,
    supportId: parsed.data.error.supportId,
  });
}

function hasMatchingRequestId(value: unknown, requestId: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    value.requestId === requestId
  );
}

function assertAiUsageSummaryScope(
  response: CloudAiUsageSummaryResponse,
  teamId: string,
  projectId: string | null,
): void {
  if (!hasMatchingAiUsageSummaryScope(response, teamId, projectId)) {
    throw protocolError("Cloud AI usage summary crossed its requested scope.", response.requestId);
  }
}

function assertAiReservationScope(
  response: CloudAiUsageReservationResponse,
  teamId: string,
  projectId: string,
  reservationId: string,
): void {
  if (
    response.reservation.teamId !== teamId ||
    response.reservation.projectId !== projectId ||
    response.reservation.reservationId !== reservationId ||
    !hasMatchingAiUsageSummaryScope(response.summary, teamId, projectId)
  ) {
    throw protocolError(
      "Cloud AI usage reservation crossed its requested scope.",
      response.requestId,
    );
  }
}

type AiUsageSummaryScopeValue = Pick<
  CloudAiUsageSummaryResponse,
  | "tenantId"
  | "teamId"
  | "teamBudget"
  | "projectBudget"
  | "team"
  | "project"
  | "activeProjectLeaseCount"
>;

function hasMatchingAiUsageSummaryScope(
  response: AiUsageSummaryScopeValue,
  teamId: string,
  projectId: string | null,
): boolean {
  const teamBudgetMatches =
    response.teamBudget === null ||
    (response.teamBudget.tenantId === response.tenantId && response.teamBudget.teamId === teamId);
  const projectBudgetMatches =
    response.projectBudget === null ||
    (projectId !== null &&
      response.projectBudget.tenantId === response.tenantId &&
      response.projectBudget.teamId === teamId &&
      response.projectBudget.projectId === projectId);
  const teamBucketMatches =
    response.team === null || (response.team.scope === "team" && response.team.projectId === null);

  if (
    response.teamId !== teamId ||
    !teamBudgetMatches ||
    !projectBudgetMatches ||
    !teamBucketMatches
  ) {
    return false;
  }

  if (projectId === null) {
    return (
      response.team !== null &&
      response.project === null &&
      response.projectBudget === null &&
      response.activeProjectLeaseCount === null
    );
  }

  return (
    response.project !== null &&
    response.project.scope === "project" &&
    response.project.projectId === projectId &&
    response.activeProjectLeaseCount !== null
  );
}

function assertGrantDevice(response: CloudSessionGrantResponse, deviceId: string): void {
  if (response.device.device.deviceId !== deviceId || response.session.deviceId !== deviceId) {
    throw protocolError(
      "Cloud session grant was issued for an unexpected device.",
      response.requestId,
    );
  }
}

function assertEnterprisePolicyScope(
  response: CloudEnterprisePolicyResponse,
  teamId: string,
): void {
  if (response.policy.teamId !== teamId) {
    throw protocolError(
      "Enterprise policy response crossed its requested scope.",
      response.requestId,
    );
  }
}

function assertDeviceResponse(response: CloudDeviceResponse, deviceId: string): void {
  if (response.device.device.deviceId !== deviceId) {
    throw protocolError("Cloud device response identity did not match.", response.requestId);
  }
}

function assertReviewScope(
  response: CloudReviewResponse,
  teamId: string,
  projectId: string,
  reviewId: string,
): void {
  if (
    response.review.teamId !== teamId ||
    response.review.projectId !== projectId ||
    response.review.reviewId !== reviewId
  ) {
    throw protocolError(
      "Cloud review response does not match its route scope.",
      response.requestId,
    );
  }
}

function assertTemplateWriteScope(
  aad: CloudTeamTemplateAad,
  teamId: string,
  projectId: string,
  templateId: string,
  versionId: string | null,
): void {
  if (
    aad.teamId !== teamId ||
    aad.projectId !== projectId ||
    aad.templateId !== templateId ||
    (versionId !== null && aad.versionId !== versionId)
  ) {
    throw requestError("Team-template ciphertext does not match its route scope.", null);
  }
}

function assertTemplateResponseScope(
  response: CloudTeamTemplateResponse,
  teamId: string,
  projectId: string,
  templateId: string,
): void {
  if (
    response.template.teamId !== teamId ||
    response.template.projectId !== projectId ||
    response.template.templateId !== templateId
  ) {
    throw protocolError(
      "Cloud team-template response crossed its route scope.",
      response.requestId,
    );
  }
}

function assertTemplateMutationResponseScope(
  response: CloudTeamTemplateMutationResponse,
  teamId: string,
  projectId: string,
  templateId: string,
  versionId: string,
): void {
  assertTemplateResponseScope(response, teamId, projectId, templateId);
  assertTemplateVersionScope(
    response.version,
    teamId,
    projectId,
    templateId,
    versionId,
    response.requestId,
  );
}

function assertTemplateVersionScope(
  version: Pick<CloudTeamTemplateVersion, "teamId" | "projectId" | "templateId" | "versionId">,
  teamId: string,
  projectId: string,
  templateId: string,
  versionId: string,
  requestId: string,
): void {
  if (
    version.teamId !== teamId ||
    version.projectId !== projectId ||
    version.templateId !== templateId ||
    version.versionId !== versionId
  ) {
    throw protocolError("Cloud team-template version response crossed its route scope.", requestId);
  }
}

function assertThreadScope(
  thread: CloudReviewThreadResponse["thread"],
  teamId: string,
  projectId: string,
  reviewId: string,
  threadId: string,
  requestId: string,
): void {
  if (
    thread.teamId !== teamId ||
    thread.projectId !== projectId ||
    thread.reviewId !== reviewId ||
    thread.threadId !== threadId
  ) {
    throw protocolError("Cloud review-thread response does not match its route scope.", requestId);
  }
}

function assertThreadItemScope(
  response: CloudReviewThreadItemResponse | CloudReviewSuggestionDecisionResponse,
  teamId: string,
  projectId: string,
  reviewId: string,
  threadId: string,
  itemId: string,
): void {
  assertThreadScope(response.thread, teamId, projectId, reviewId, threadId, response.requestId);
  if (
    response.item.teamId !== teamId ||
    response.item.projectId !== projectId ||
    response.item.reviewId !== reviewId ||
    response.item.threadId !== threadId ||
    response.item.itemId !== itemId
  ) {
    throw protocolError(
      "Cloud review-thread item response does not match its route scope.",
      response.requestId,
    );
  }
}

function assertDeletionResponseScope(
  response: CloudDeletionRequestResponse,
  targetKind: "account" | "project",
  targetId?: string,
  deletionRequestId?: string,
): void {
  if (
    response.deletionRequest.targetKind !== targetKind ||
    (targetId !== undefined && response.deletionRequest.targetId !== targetId) ||
    (deletionRequestId !== undefined &&
      response.deletionRequest.deletionRequestId !== deletionRequestId)
  ) {
    throw protocolError(
      "Cloud deletion response does not match its requested scope.",
      response.requestId,
    );
  }
}

function assertCancelledDeletion(response: CloudDeletionRequestResponse): void {
  if (response.deletionRequest.state !== "cancelled") {
    throw protocolError(
      "Cloud deletion cancellation did not return a cancelled request.",
      response.requestId,
    );
  }
}

function assertProjectKeyRequestScope(
  request: CloudProjectKeyPublishRequest,
  projectId: string,
  keyVersion: number,
  requestId: string,
): void {
  if (
    request.version.projectId !== projectId ||
    request.version.keyVersion !== keyVersion ||
    request.recoveryEnvelope.projectId !== projectId ||
    request.recoveryEnvelope.keyVersion !== keyVersion ||
    request.deviceEnvelopes.some(
      (envelope) => envelope.projectId !== projectId || envelope.keyVersion !== keyVersion,
    )
  ) {
    throw requestError("Project-key request does not match its route scope.", requestId);
  }
}

function assertProjectKeyResponseScope(
  response: CloudProjectKeyResponse,
  projectId: string,
  keyVersion: number,
): void {
  if (response.keySet.projectId !== projectId || response.keySet.keyVersion !== keyVersion) {
    throw protocolError(
      "Cloud project-key response does not match its route scope.",
      response.requestId,
    );
  }
}

function assertSyncPushScope(
  request: Pick<CloudSyncPushRequest, "chunks" | "operations" | "tombstones">,
  projectId: string,
  remote: boolean,
  requestId: string | null,
): void {
  if (
    request.operations.some((operation) => operation.projectId !== projectId) ||
    request.chunks.some((chunk) => chunk.encrypted.aad.projectId !== projectId) ||
    request.tombstones.some((tombstone) => tombstone.projectId !== projectId)
  ) {
    if (remote) {
      throw protocolError("Cloud sync response crossed its project scope.", requestId);
    }
    throw requestError("Sync push does not match its project route scope.", requestId);
  }
}

function assertSyncSnapshotResponse(response: CloudSyncSnapshotResponse, projectId: string): void {
  if (
    response.projectId !== projectId ||
    response.operations.some((operation) => operation.projectId !== projectId) ||
    response.chunks.some((chunk) => chunk.encrypted.aad.projectId !== projectId) ||
    response.tombstones.some((tombstone) => tombstone.projectId !== projectId)
  ) {
    throw protocolError(
      "Cloud sync snapshot response crossed its project scope.",
      response.requestId,
    );
  }
  if (
    response.hasMore !== (response.nextSnapshotCursor !== null) ||
    response.nextSnapshotCursor === response.resumeCursor
  ) {
    throw protocolError(
      "Cloud sync snapshot response contained invalid cursor state.",
      response.requestId,
    );
  }
}

function authenticationRequired(requestId: string, causeType: string | null): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_AUTHENTICATION_REQUIRED",
    message: "A valid cloud session is required for this operation.",
    status: null,
    requestId,
    retryable: true,
    actions: ["REAUTHENTICATE", "USE_LOCAL"],
    causeType,
  });
}

function requestError(message: string, requestId: string | null): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_REQUEST_INVALID",
    message,
    status: null,
    requestId,
    retryable: false,
  });
}

function protocolError(message: string, requestId: string | null): CloudClientError {
  return new CloudClientError({
    code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    message,
    status: null,
    requestId,
    retryable: false,
    actions: ["RETRY", "CONTACT_SUPPORT"],
  });
}
