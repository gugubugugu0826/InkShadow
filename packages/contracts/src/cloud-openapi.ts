import type { ZodType } from "zod";

import {
  CloudAccountDeletionCancellationRequestSchema,
  CloudAccountDeletionLookupRequestSchema,
  CloudAccountDeletionSubmissionRequestSchema,
  CloudApiErrorResponseSchema,
  CloudAuthenticationRequestSchema,
  CloudDeletionCancellationRequestSchema,
  CloudDeletionRequestSchema,
  CloudDeletionRequestResponseSchema,
  CloudDeletionSubmissionRequestSchema,
  CloudDeviceListResponseSchema,
  CloudDeviceRegistrationRequestSchema,
  CloudDeviceResponseSchema,
  CloudIdentityChallengeResponseSchema,
  CloudIdentityRegistrationRequestSchema,
  CloudIdentityVerificationRequestSchema,
  CloudMutationAcceptedResponseSchema,
  CloudPasswordResetConfirmationRequestSchema,
  CloudPasswordResetRequestSchema,
  CloudProjectKeyPublishRequestSchema,
  CloudProjectKeyResponseSchema,
  CloudProjectStateResponseSchema,
  CloudSessionGrantResponseSchema,
  CloudSessionListResponseSchema,
  CloudSessionLogoutRequestSchema,
  CloudSessionRefreshRequestSchema,
  CloudSyncPullResponseSchema,
  CloudSyncPushRequestSchema,
  CloudSyncPushResponseSchema,
  CloudSyncSnapshotResponseSchema,
  CloudTombstoneAcknowledgementRequestSchema,
} from "./cloud-api-schemas.js";
import {
  CloudProjectAssignmentListResponseSchema,
  CloudProjectAssignmentResponseSchema,
  CloudProjectAssignmentSetRequestSchema,
  CloudTeamCreateRequestSchema,
  CloudTeamInvitationAcceptanceResponseSchema,
  CloudTeamInvitationAcceptRequestSchema,
  CloudTeamInvitationCreateRequestSchema,
  CloudTeamInvitationResponseSchema,
  CloudTeamListResponseSchema,
  CloudTeamMemberListResponseSchema,
  CloudTeamMemberRoleChangeRequestSchema,
  CloudTeamMembershipResponseSchema,
  CloudTeamMembershipRevokeRequestSchema,
  CloudTeamProjectCurrentKeyResponseSchema,
  CloudTeamProjectKeyEligibleRecipientListResponseSchema,
  CloudTeamProjectKeyEnvelopePublishRequestSchema,
  CloudTeamProjectKeyEnvelopeResponseSchema,
  CloudTeamResponseSchema,
} from "./team-api-schemas.js";
import {
  CloudReviewDecisionRequestSchema,
  CloudReviewListResponseSchema,
  CloudReviewResponseSchema,
  CloudReviewSubmissionRequestSchema,
  CloudReviewSuggestionDecisionRequestSchema,
  CloudReviewSuggestionDecisionResponseSchema,
  CloudReviewThreadItemAppendRequestSchema,
  CloudReviewThreadItemListResponseSchema,
  CloudReviewThreadItemResponseSchema,
  CloudReviewThreadListResponseSchema,
  CloudReviewThreadResolutionRequestSchema,
  CloudReviewThreadResponseSchema,
} from "./review-api-schemas.js";
import {
  CloudAiProjectBudgetResponseSchema,
  CloudAiProjectBudgetUpdateRequestSchema,
  CloudAiTeamBudgetResponseSchema,
  CloudAiTeamBudgetUpdateRequestSchema,
  CloudAiUsageCancellationRequestSchema,
  CloudAiUsageEventListResponseSchema,
  CloudAiUsageReservationRequestSchema,
  CloudAiUsageReservationResponseSchema,
  CloudAiUsageSettlementRequestSchema,
  CloudAiUsageSummaryResponseSchema,
} from "./usage-api-schemas.js";
import {
  CloudTeamTemplateApplicationResponseSchema,
  CloudTeamTemplateApplyRequestSchema,
  CloudTeamTemplateArchiveRequestSchema,
  CloudTeamTemplateCloneRequestSchema,
  CloudTeamTemplateCreateRequestSchema,
  CloudTeamTemplateListResponseSchema,
  CloudTeamTemplateMutationResponseSchema,
  CloudTeamTemplatePublishRequestSchema,
  CloudTeamTemplateResponseSchema,
  CloudTeamTemplateVersionCreateRequestSchema,
  CloudTeamTemplateVersionListResponseSchema,
  CloudTeamTemplateVersionResponseSchema,
} from "./team-template-api-schemas.js";
import {
  CloudEnterprisePolicyEvaluationRequestSchema,
  CloudEnterprisePolicyEvaluationResponseSchema,
  CloudEnterprisePolicyResponseSchema,
  CloudEnterprisePolicyUpdateRequestSchema,
  CloudEnterpriseSsoAuthorizationRequestSchema,
  CloudEnterpriseSsoAuthorizationResponseSchema,
  CloudEnterpriseSsoCallbackRequestSchema,
  CloudEnterpriseSsoSessionResponseSchema,
  CloudEnterpriseSsoStatusResponseSchema,
} from "./enterprise-api-schemas.js";
import {
  CloudMarketplaceAppealDispositionRequestSchema,
  CloudMarketplaceAppealRequestSchema,
  CloudMarketplaceAppealResponseSchema,
  CloudMarketplaceCatalogResponseSchema,
  CloudMarketplaceDownloadRequestSchema,
  CloudMarketplaceDownloadResponseSchema,
  CloudMarketplaceModerationQueueResponseSchema,
  CloudMarketplaceModerationRequestSchema,
  CloudMarketplaceReportDispositionRequestSchema,
  CloudMarketplaceReportRequestSchema,
  CloudMarketplaceReportResponseSchema,
  CloudMarketplaceSubmissionRequestSchema,
  CloudMarketplaceSubmissionResponseSchema,
  CloudMarketplaceWithdrawalRequestSchema,
} from "./marketplace-api-schemas.js";

export type CloudApiHttpMethod = "delete" | "get" | "post" | "put";

interface CloudApiQueryParameter {
  readonly name: string;
  readonly required: boolean;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface CloudApiOperationDefinition {
  readonly operationId: CloudApiOperationId;
  readonly description?: string;
  readonly method: CloudApiHttpMethod;
  readonly path: string;
  readonly requiresAuthentication: boolean;
  readonly requiresIdempotencyKey: boolean;
  readonly requiresNativePasswordBoundary: boolean;
  readonly requestSchemaName: CloudApiComponentSchemaName | null;
  readonly successSchemaName: CloudApiComponentSchemaName;
  readonly successStatus: number;
  readonly queryParameters?: readonly CloudApiQueryParameter[];
}

const cloudApiComponentSchemas = {
  AccountDeletionCancellationRequest: CloudAccountDeletionCancellationRequestSchema,
  AccountDeletionLookupRequest: CloudAccountDeletionLookupRequestSchema,
  AccountDeletionSubmissionRequest: CloudAccountDeletionSubmissionRequestSchema,
  ApiErrorResponse: CloudApiErrorResponseSchema,
  AiProjectBudgetResponse: CloudAiProjectBudgetResponseSchema,
  AiProjectBudgetUpdateRequest: CloudAiProjectBudgetUpdateRequestSchema,
  AiTeamBudgetResponse: CloudAiTeamBudgetResponseSchema,
  AiTeamBudgetUpdateRequest: CloudAiTeamBudgetUpdateRequestSchema,
  AiUsageCancellationRequest: CloudAiUsageCancellationRequestSchema,
  AiUsageEventListResponse: CloudAiUsageEventListResponseSchema,
  AiUsageReservationRequest: CloudAiUsageReservationRequestSchema,
  AiUsageReservationResponse: CloudAiUsageReservationResponseSchema,
  AiUsageSettlementRequest: CloudAiUsageSettlementRequestSchema,
  AiUsageSummaryResponse: CloudAiUsageSummaryResponseSchema,
  AuthenticationRequest: CloudAuthenticationRequestSchema,
  ProjectAssignmentListResponse: CloudProjectAssignmentListResponseSchema,
  ProjectAssignmentResponse: CloudProjectAssignmentResponseSchema,
  ProjectAssignmentSetRequest: CloudProjectAssignmentSetRequestSchema,
  DeletionCancellationRequest: CloudDeletionCancellationRequestSchema,
  DeletionRequest: CloudDeletionRequestSchema,
  DeletionRequestResponse: CloudDeletionRequestResponseSchema,
  DeletionSubmissionRequest: CloudDeletionSubmissionRequestSchema,
  DeviceListResponse: CloudDeviceListResponseSchema,
  DeviceRegistrationRequest: CloudDeviceRegistrationRequestSchema,
  DeviceResponse: CloudDeviceResponseSchema,
  EnterprisePolicyEvaluationRequest: CloudEnterprisePolicyEvaluationRequestSchema,
  EnterprisePolicyEvaluationResponse: CloudEnterprisePolicyEvaluationResponseSchema,
  EnterprisePolicyResponse: CloudEnterprisePolicyResponseSchema,
  EnterprisePolicyUpdateRequest: CloudEnterprisePolicyUpdateRequestSchema,
  EnterpriseSsoAuthorizationRequest: CloudEnterpriseSsoAuthorizationRequestSchema,
  EnterpriseSsoAuthorizationResponse: CloudEnterpriseSsoAuthorizationResponseSchema,
  EnterpriseSsoCallbackRequest: CloudEnterpriseSsoCallbackRequestSchema,
  EnterpriseSsoSessionResponse: CloudEnterpriseSsoSessionResponseSchema,
  EnterpriseSsoStatusResponse: CloudEnterpriseSsoStatusResponseSchema,
  IdentityChallengeResponse: CloudIdentityChallengeResponseSchema,
  IdentityRegistrationRequest: CloudIdentityRegistrationRequestSchema,
  IdentityVerificationRequest: CloudIdentityVerificationRequestSchema,
  MarketplaceAppealDispositionRequest: CloudMarketplaceAppealDispositionRequestSchema,
  MarketplaceAppealRequest: CloudMarketplaceAppealRequestSchema,
  MarketplaceAppealResponse: CloudMarketplaceAppealResponseSchema,
  MarketplaceCatalogResponse: CloudMarketplaceCatalogResponseSchema,
  MarketplaceDownloadRequest: CloudMarketplaceDownloadRequestSchema,
  MarketplaceDownloadResponse: CloudMarketplaceDownloadResponseSchema,
  MarketplaceModerationQueueResponse: CloudMarketplaceModerationQueueResponseSchema,
  MarketplaceModerationRequest: CloudMarketplaceModerationRequestSchema,
  MarketplaceReportDispositionRequest: CloudMarketplaceReportDispositionRequestSchema,
  MarketplaceReportRequest: CloudMarketplaceReportRequestSchema,
  MarketplaceReportResponse: CloudMarketplaceReportResponseSchema,
  MarketplaceSubmissionRequest: CloudMarketplaceSubmissionRequestSchema,
  MarketplaceSubmissionResponse: CloudMarketplaceSubmissionResponseSchema,
  MarketplaceWithdrawalRequest: CloudMarketplaceWithdrawalRequestSchema,
  MutationAcceptedResponse: CloudMutationAcceptedResponseSchema,
  PasswordResetConfirmationRequest: CloudPasswordResetConfirmationRequestSchema,
  PasswordResetRequest: CloudPasswordResetRequestSchema,
  ProjectKeyPublishRequest: CloudProjectKeyPublishRequestSchema,
  ProjectKeyResponse: CloudProjectKeyResponseSchema,
  ProjectStateResponse: CloudProjectStateResponseSchema,
  ReviewDecisionRequest: CloudReviewDecisionRequestSchema,
  ReviewListResponse: CloudReviewListResponseSchema,
  ReviewResponse: CloudReviewResponseSchema,
  ReviewSubmissionRequest: CloudReviewSubmissionRequestSchema,
  ReviewSuggestionDecisionRequest: CloudReviewSuggestionDecisionRequestSchema,
  ReviewSuggestionDecisionResponse: CloudReviewSuggestionDecisionResponseSchema,
  ReviewThreadItemAppendRequest: CloudReviewThreadItemAppendRequestSchema,
  ReviewThreadItemListResponse: CloudReviewThreadItemListResponseSchema,
  ReviewThreadItemResponse: CloudReviewThreadItemResponseSchema,
  ReviewThreadListResponse: CloudReviewThreadListResponseSchema,
  ReviewThreadResolutionRequest: CloudReviewThreadResolutionRequestSchema,
  ReviewThreadResponse: CloudReviewThreadResponseSchema,
  SessionGrantResponse: CloudSessionGrantResponseSchema,
  SessionListResponse: CloudSessionListResponseSchema,
  SessionLogoutRequest: CloudSessionLogoutRequestSchema,
  SessionRefreshRequest: CloudSessionRefreshRequestSchema,
  SyncPullResponse: CloudSyncPullResponseSchema,
  SyncPushRequest: CloudSyncPushRequestSchema,
  SyncPushResponse: CloudSyncPushResponseSchema,
  SyncSnapshotResponse: CloudSyncSnapshotResponseSchema,
  TeamCreateRequest: CloudTeamCreateRequestSchema,
  TeamInvitationAcceptanceResponse: CloudTeamInvitationAcceptanceResponseSchema,
  TeamInvitationAcceptRequest: CloudTeamInvitationAcceptRequestSchema,
  TeamInvitationCreateRequest: CloudTeamInvitationCreateRequestSchema,
  TeamInvitationResponse: CloudTeamInvitationResponseSchema,
  TeamListResponse: CloudTeamListResponseSchema,
  TeamMemberListResponse: CloudTeamMemberListResponseSchema,
  TeamMemberRoleChangeRequest: CloudTeamMemberRoleChangeRequestSchema,
  TeamMembershipResponse: CloudTeamMembershipResponseSchema,
  TeamMembershipRevokeRequest: CloudTeamMembershipRevokeRequestSchema,
  TeamProjectCurrentKeyResponse: CloudTeamProjectCurrentKeyResponseSchema,
  TeamProjectKeyEligibleRecipientListResponse:
    CloudTeamProjectKeyEligibleRecipientListResponseSchema,
  TeamProjectKeyEnvelopePublishRequest: CloudTeamProjectKeyEnvelopePublishRequestSchema,
  TeamProjectKeyEnvelopeResponse: CloudTeamProjectKeyEnvelopeResponseSchema,
  TeamResponse: CloudTeamResponseSchema,
  TeamTemplateApplicationResponse: CloudTeamTemplateApplicationResponseSchema,
  TeamTemplateApplyRequest: CloudTeamTemplateApplyRequestSchema,
  TeamTemplateArchiveRequest: CloudTeamTemplateArchiveRequestSchema,
  TeamTemplateCloneRequest: CloudTeamTemplateCloneRequestSchema,
  TeamTemplateCreateRequest: CloudTeamTemplateCreateRequestSchema,
  TeamTemplateListResponse: CloudTeamTemplateListResponseSchema,
  TeamTemplateMutationResponse: CloudTeamTemplateMutationResponseSchema,
  TeamTemplatePublishRequest: CloudTeamTemplatePublishRequestSchema,
  TeamTemplateResponse: CloudTeamTemplateResponseSchema,
  TeamTemplateVersionCreateRequest: CloudTeamTemplateVersionCreateRequestSchema,
  TeamTemplateVersionListResponse: CloudTeamTemplateVersionListResponseSchema,
  TeamTemplateVersionResponse: CloudTeamTemplateVersionResponseSchema,
  TombstoneAcknowledgementRequest: CloudTombstoneAcknowledgementRequestSchema,
} satisfies Record<string, ZodType>;

export type CloudApiComponentSchemaName = keyof typeof cloudApiComponentSchemas;

const operationDefinitions = [
  operation({
    operationId: "accountDeletions.request",
    description:
      "Schedules permanent account deletion after the bearer account, canonical email and password all match. A successful response means every account session has already been revoked; later lookup and cancellation use the deletion proof without bearer authentication.",
    method: "post",
    path: "/v1/account/deletion-requests",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requiresNativePasswordBoundary: true,
    requestSchemaName: "AccountDeletionSubmissionRequest",
    successSchemaName: "DeletionRequestResponse",
    successStatus: 202,
  }),
  operation({
    operationId: "accountDeletions.lookup",
    description:
      "Looks up an account deletion after session revocation using email, password and exactly one of deletionRequestId or the original confirmationId. Unknown requests and invalid credentials have indistinguishable errors.",
    method: "post",
    path: "/v1/account/deletion-request-lookups",
    requiresAuthentication: false,
    requiresIdempotencyKey: false,
    requiresNativePasswordBoundary: true,
    requestSchemaName: "AccountDeletionLookupRequest",
    successSchemaName: "DeletionRequestResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "accountDeletions.cancel",
    description:
      "Cancels an account deletion after session revocation using email, password and deletionRequestId. Unknown requests and invalid credentials have indistinguishable errors.",
    method: "post",
    path: "/v1/account/deletion-cancellations",
    requiresAuthentication: false,
    requiresIdempotencyKey: true,
    requiresNativePasswordBoundary: true,
    requestSchemaName: "AccountDeletionCancellationRequest",
    successSchemaName: "DeletionRequestResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "identity.register",
    method: "post",
    path: "/v1/identity/registrations",
    requiresAuthentication: false,
    requiresIdempotencyKey: true,
    requestSchemaName: "IdentityRegistrationRequest",
    successSchemaName: "IdentityChallengeResponse",
    successStatus: 202,
  }),
  operation({
    operationId: "identity.verifyEmail",
    method: "post",
    path: "/v1/identity/verifications",
    requiresAuthentication: false,
    requiresIdempotencyKey: true,
    requestSchemaName: "IdentityVerificationRequest",
    successSchemaName: "SessionGrantResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "identity.requestPasswordReset",
    method: "post",
    path: "/v1/identity/password-resets",
    requiresAuthentication: false,
    requiresIdempotencyKey: true,
    requestSchemaName: "PasswordResetRequest",
    successSchemaName: "IdentityChallengeResponse",
    successStatus: 202,
  }),
  operation({
    operationId: "identity.confirmPasswordReset",
    method: "post",
    path: "/v1/identity/password-resets/confirmations",
    requiresAuthentication: false,
    requiresIdempotencyKey: true,
    requestSchemaName: "PasswordResetConfirmationRequest",
    successSchemaName: "MutationAcceptedResponse",
    successStatus: 202,
  }),
  operation({
    operationId: "auth.login",
    method: "post",
    path: "/v1/auth/sessions",
    requiresAuthentication: false,
    requiresIdempotencyKey: true,
    requestSchemaName: "AuthenticationRequest",
    successSchemaName: "SessionGrantResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "auth.refresh",
    method: "post",
    path: "/v1/auth/session-rotations",
    requiresAuthentication: false,
    requiresIdempotencyKey: true,
    requestSchemaName: "SessionRefreshRequest",
    successSchemaName: "SessionGrantResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "auth.logout",
    method: "post",
    path: "/v1/auth/session-revocations",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "SessionLogoutRequest",
    successSchemaName: "MutationAcceptedResponse",
    successStatus: 202,
  }),
  operation({
    operationId: "auth.listSessions",
    method: "get",
    path: "/v1/auth/sessions",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "SessionListResponse",
    successStatus: 200,
    queryParameters: cursorQueryParameters(),
  }),
  operation({
    operationId: "auth.revokeSession",
    method: "delete",
    path: "/v1/auth/sessions/{sessionId}",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: null,
    successSchemaName: "MutationAcceptedResponse",
    successStatus: 202,
  }),
  operation({
    operationId: "devices.list",
    method: "get",
    path: "/v1/devices",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "DeviceListResponse",
    successStatus: 200,
    queryParameters: cursorQueryParameters(),
  }),
  operation({
    operationId: "devices.register",
    method: "post",
    path: "/v1/devices",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "DeviceRegistrationRequest",
    successSchemaName: "DeviceResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "devices.revoke",
    method: "delete",
    path: "/v1/devices/{deviceId}",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: null,
    successSchemaName: "DeviceResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "teams.create",
    method: "post",
    path: "/v1/teams",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamCreateRequest",
    successSchemaName: "TeamResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "teams.list",
    method: "get",
    path: "/v1/teams",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "TeamListResponse",
    successStatus: 200,
    queryParameters: cursorQueryParameters(),
  }),
  operation({
    operationId: "teamMembers.list",
    method: "get",
    path: "/v1/teams/{teamId}/members",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "TeamMemberListResponse",
    successStatus: 200,
    queryParameters: cursorQueryParameters(),
  }),
  operation({
    operationId: "teamInvitations.create",
    method: "post",
    path: "/v1/teams/{teamId}/invitations",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamInvitationCreateRequest",
    successSchemaName: "TeamInvitationResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "teamInvitations.accept",
    method: "post",
    path: "/v1/team-invitations/{invitationId}/acceptances",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamInvitationAcceptRequest",
    successSchemaName: "TeamInvitationAcceptanceResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "teamMembers.changeRole",
    method: "post",
    path: "/v1/teams/{teamId}/members/{membershipId}/role-changes",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamMemberRoleChangeRequest",
    successSchemaName: "TeamMembershipResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "teamMembers.revoke",
    method: "post",
    path: "/v1/teams/{teamId}/members/{membershipId}/revocations",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamMembershipRevokeRequest",
    successSchemaName: "TeamMembershipResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "projectAssignments.list",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/assignments",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "ProjectAssignmentListResponse",
    successStatus: 200,
    queryParameters: cursorQueryParameters(),
  }),
  operation({
    operationId: "projectAssignments.set",
    method: "put",
    path: "/v1/teams/{teamId}/projects/{projectId}/assignments/{membershipId}",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "ProjectAssignmentSetRequest",
    successSchemaName: "ProjectAssignmentResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "enterprisePolicies.get",
    description:
      "Returns the authoritative, tenant-scoped organization policy. The route fails closed when the deployment license or policy is unavailable.",
    method: "get",
    path: "/v1/teams/{teamId}/enterprise/policy",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "EnterprisePolicyResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "enterprisePolicies.update",
    description:
      "Creates or revision-updates organization SSO, session, device, export, external-egress and support governance. Only team owners and administrators may mutate policy.",
    method: "put",
    path: "/v1/teams/{teamId}/enterprise/policy",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "EnterprisePolicyUpdateRequest",
    successSchemaName: "EnterprisePolicyResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "enterprisePolicies.evaluate",
    description:
      "Evaluates the current principal, device and requested governed action against the authoritative organization policy without mutating policy state.",
    method: "post",
    path: "/v1/teams/{teamId}/enterprise/policy-evaluations",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "EnterprisePolicyEvaluationRequest",
    successSchemaName: "EnterprisePolicyEvaluationResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "enterpriseSso.getStatus",
    description:
      "Returns non-secret OIDC configuration status for an authorized organization administrator. Client secrets, discovery documents and keys are never returned.",
    method: "get",
    path: "/v1/teams/{teamId}/enterprise/sso",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "EnterpriseSsoStatusResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "enterpriseSso.authorize",
    description:
      "Creates a one-time OIDC authorization flow bound to the team, exact redirect URI and exact device identity. State, nonce and S256 PKCE values are server-derived from a client-held flow secret.",
    method: "post",
    path: "/v1/enterprise/sso/authorizations",
    requiresAuthentication: false,
    requiresIdempotencyKey: true,
    requestSchemaName: "EnterpriseSsoAuthorizationRequest",
    successSchemaName: "EnterpriseSsoAuthorizationResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "enterpriseSso.complete",
    description:
      "Consumes a one-time OIDC callback after exact state, redirect, device, PKCE, nonce, issuer, audience, signature, domain and membership validation, then issues a device-bound InkShadow session.",
    method: "post",
    path: "/v1/enterprise/sso/callbacks",
    requiresAuthentication: false,
    requiresIdempotencyKey: true,
    requestSchemaName: "EnterpriseSsoCallbackRequest",
    successSchemaName: "EnterpriseSsoSessionResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "aiBudgets.updateTeam",
    description:
      "Creates or revision-updates the authoritative monthly team AI hard cap and token price version. Owner, admin or the explicit billing.manage capability is required.",
    method: "put",
    path: "/v1/teams/{teamId}/ai-budget",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "AiTeamBudgetUpdateRequest",
    successSchemaName: "AiTeamBudgetResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "aiBudgets.updateProject",
    description:
      "Creates or revision-updates an optional project hard cap under the authoritative team cap. A null limit disables the project-specific cap without deleting history.",
    method: "put",
    path: "/v1/teams/{teamId}/projects/{projectId}/ai-budget",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "AiProjectBudgetUpdateRequest",
    successSchemaName: "AiProjectBudgetResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "aiUsage.getSummary",
    description:
      "Returns settled and currently reserved metadata-only AI usage for the authorized team or project month, after reclaiming expired leases.",
    method: "get",
    path: "/v1/teams/{teamId}/ai-usage",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "AiUsageSummaryResponse",
    successStatus: 200,
    queryParameters: [
      {
        name: "projectId",
        required: false,
        schema: { type: "string", format: "uuid" },
      },
    ],
  }),
  operation({
    operationId: "aiUsage.listEvents",
    description:
      "Lists append-only metadata-only reservation, settlement, cancellation and lease-expiry events. Creative content, prompts, keys and ciphertext are never accepted or returned.",
    method: "get",
    path: "/v1/teams/{teamId}/ai-usage/events",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "AiUsageEventListResponse",
    successStatus: 200,
    queryParameters: usageEventQueryParameters(),
  }),
  operation({
    operationId: "aiUsage.reserve",
    description:
      "Atomically reserves team and optional project budget using server-owned token prices and a bounded lease. Concurrent calls cannot cross the hard cap.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/ai-usage/reservations",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "AiUsageReservationRequest",
    successSchemaName: "AiUsageReservationResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "aiUsage.settle",
    description:
      "Settles actual token usage no greater than the active reservation. Exact replay converges through idempotency and revision checks.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/ai-usage/reservations/{reservationId}/settlements",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "AiUsageSettlementRequest",
    successSchemaName: "AiUsageReservationResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "aiUsage.cancel",
    description:
      "Cancels an active reservation and releases its capacity. Exact replay converges and terminal reservations cannot be changed.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/ai-usage/reservations/{reservationId}/cancellations",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "AiUsageCancellationRequest",
    successSchemaName: "AiUsageReservationResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "teamProjectKeys.getCurrent",
    description:
      "Returns only the authoritative active team-project key version and whether an active envelope exists for the authenticated session device. Active membership, exact active project assignment and project.read authorization are required; no ciphertext, public keys, recovery material or other recipients are returned.",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/keys/current",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "TeamProjectCurrentKeyResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "teamProjectKeyRecipients.list",
    description:
      "Lists only trusted devices belonging to active team memberships with active project assignments. The response contains public key material and exact membership/assignment revisions, but no envelopes, invitation credentials or recovery ciphertext.",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/keys/{keyVersion}/recipients",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "TeamProjectKeyEligibleRecipientListResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "teamProjectKeyEnvelopes.publish",
    description:
      "Publishes one client-created HPKE envelope after exact team, project, key, membership, assignment, device and public-key-fingerprint checks. Stable idempotency is mandatory.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/keys/{keyVersion}/envelopes",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamProjectKeyEnvelopePublishRequest",
    successSchemaName: "TeamProjectKeyEnvelopeResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "teamProjectKeyEnvelopes.getCurrentDevice",
    description:
      "Returns exactly the authenticated session device's own active team-project key envelope. Other recipient ciphertexts are never included.",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/keys/{keyVersion}/envelopes/current-device",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "TeamProjectKeyEnvelopeResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "reviews.submit",
    description:
      "Submits an immutable, exact source-version review envelope. The server stores opaque AES-GCM ciphertext and version/key metadata only.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/reviews",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "ReviewSubmissionRequest",
    successSchemaName: "ReviewResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "reviews.list",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/reviews",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "ReviewListResponse",
    successStatus: 200,
    queryParameters: reviewCursorQueryParameters(),
  }),
  operation({
    operationId: "reviews.get",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "ReviewResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "reviewDecisions.create",
    description:
      "Approves or rejects an immutable submitted version with an exact expected revision. It never writes project content.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/decisions",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "ReviewDecisionRequest",
    successSchemaName: "ReviewResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "reviewThreadItems.append",
    description:
      "Creates an encrypted comment, suggestion, question or rewrite-request thread, or appends an encrypted reply under exact thread CAS.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/thread-items",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "ReviewThreadItemAppendRequest",
    successSchemaName: "ReviewThreadItemResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "reviewThreads.list",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/threads",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "ReviewThreadListResponse",
    successStatus: 200,
    queryParameters: reviewCursorQueryParameters(),
  }),
  operation({
    operationId: "reviewThreadItems.list",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/threads/{threadId}/items",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "ReviewThreadItemListResponse",
    successStatus: 200,
    queryParameters: reviewCursorQueryParameters(),
  }),
  operation({
    operationId: "reviewThreads.resolve",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/threads/{threadId}/resolutions",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "ReviewThreadResolutionRequest",
    successSchemaName: "ReviewThreadResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "reviewSuggestionDecisions.create",
    description:
      "Records author-side acceptance or rejection metadata for an encrypted suggestion. The operation cannot mutate formal content.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/threads/{threadId}/suggestions/{itemId}/decisions",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "ReviewSuggestionDecisionRequest",
    successSchemaName: "ReviewSuggestionDecisionResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "teamTemplates.create",
    description:
      "Creates a project-bound draft template and immutable encrypted version 1. Only opaque project-DEK ciphertext and public AEAD binding metadata reach the service.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/templates",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamTemplateCreateRequest",
    successSchemaName: "TeamTemplateMutationResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "teamTemplates.list",
    description:
      "Lists only non-sensitive lifecycle metadata for templates in one actively assigned team project.",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/templates",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "TeamTemplateListResponse",
    successStatus: 200,
    queryParameters: reviewCursorQueryParameters(),
  }),
  operation({
    operationId: "teamTemplates.get",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "TeamTemplateResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "teamTemplateVersions.create",
    description:
      "Appends one immutable ciphertext version to a draft under exact template revision CAS. Published and archived templates cannot be changed in place.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/versions",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamTemplateVersionCreateRequest",
    successSchemaName: "TeamTemplateMutationResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "teamTemplateVersions.list",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/versions",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "TeamTemplateVersionListResponse",
    successStatus: 200,
    queryParameters: reviewCursorQueryParameters(),
  }),
  operation({
    operationId: "teamTemplateVersions.get",
    method: "get",
    path: "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/versions/{versionId}",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "TeamTemplateVersionResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "teamTemplates.clone",
    description:
      "Creates a new draft from a readable same-project source version. The client must decrypt and re-encrypt for the new immutable target AAD.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/clones",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamTemplateCloneRequest",
    successSchemaName: "TeamTemplateMutationResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "teamTemplates.publish",
    description:
      "Publishes the exact latest immutable draft version under revision CAS. Owner or admin authorization is required.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/publications",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamTemplatePublishRequest",
    successSchemaName: "TeamTemplateResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "teamTemplates.archive",
    description:
      "Archives a draft or published template under revision CAS while preserving immutable history for authorized reads and exports.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/archives",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamTemplateArchiveRequest",
    successSchemaName: "TeamTemplateResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "teamTemplateApplications.record",
    description:
      "Records metadata only after a client has atomically and idempotently applied a decrypted template locally. The server never mutates project content.",
    method: "post",
    path: "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/applications",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TeamTemplateApplyRequest",
    successSchemaName: "TeamTemplateApplicationResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "marketplace.listCatalog",
    description:
      "Lists only published structured community artifacts. The feature is server-gated and installed local copies remain independent of this service.",
    method: "get",
    path: "/v1/marketplace/artifacts",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "MarketplaceCatalogResponse",
    successStatus: 200,
    queryParameters: marketplaceCatalogQueryParameters(),
  }),
  operation({
    operationId: "marketplace.submitVersion",
    description:
      "Submits a data-only structured artifact whose digest and Ed25519 author signature are bound to the exact canonical payload.",
    method: "post",
    path: "/v1/marketplace/artifacts/submissions",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "MarketplaceSubmissionRequest",
    successSchemaName: "MarketplaceSubmissionResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "marketplace.moderateVersion",
    description:
      "Performs a high-risk moderation transition. Platform-operations authorization, strong MFA, an explicit reason and exact confirmation are required by the service.",
    method: "post",
    path: "/v1/marketplace/artifacts/{artifactId}/versions/{versionId}/moderation",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "MarketplaceModerationRequest",
    successSchemaName: "MarketplaceSubmissionResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "marketplace.reportVersion",
    method: "post",
    path: "/v1/marketplace/artifacts/{artifactId}/versions/{versionId}/reports",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "MarketplaceReportRequest",
    successSchemaName: "MarketplaceReportResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "marketplace.withdrawVersion",
    method: "post",
    path: "/v1/marketplace/artifacts/{artifactId}/versions/{versionId}/withdrawals",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "MarketplaceWithdrawalRequest",
    successSchemaName: "MarketplaceSubmissionResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "marketplace.appealVersion",
    method: "post",
    path: "/v1/marketplace/artifacts/{artifactId}/versions/{versionId}/appeals",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "MarketplaceAppealRequest",
    successSchemaName: "MarketplaceAppealResponse",
    successStatus: 201,
  }),
  operation({
    operationId: "marketplace.disposeReport",
    description:
      "Disposes a report under platform-operations authorization, strong MFA and exact high-risk confirmation.",
    method: "post",
    path: "/v1/marketplace/reports/{reportId}/dispositions",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "MarketplaceReportDispositionRequest",
    successSchemaName: "MarketplaceReportResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "marketplace.disposeAppeal",
    description:
      "Disposes an appeal under platform-operations authorization, strong MFA and exact high-risk confirmation.",
    method: "post",
    path: "/v1/marketplace/appeals/{appealId}/dispositions",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "MarketplaceAppealDispositionRequest",
    successSchemaName: "MarketplaceAppealResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "marketplace.download",
    description:
      "Returns the exact published structured payload together with its author public key, signature and immutable audit receipt.",
    method: "post",
    path: "/v1/marketplace/artifacts/{artifactId}/downloads",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "MarketplaceDownloadRequest",
    successSchemaName: "MarketplaceDownloadResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "marketplace.listModerationQueue",
    description:
      "Lists the moderation queue only for a strongly authenticated platform-operations principal.",
    method: "get",
    path: "/v1/marketplace/moderation/queue",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "MarketplaceModerationQueueResponse",
    successStatus: 200,
    queryParameters: marketplacePageQueryParameters(),
  }),
  operation({
    operationId: "projectDeletions.request",
    method: "post",
    path: "/v1/projects/{projectId}/deletion-requests",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requiresNativePasswordBoundary: true,
    requestSchemaName: "DeletionSubmissionRequest",
    successSchemaName: "DeletionRequestResponse",
    successStatus: 202,
  }),
  operation({
    operationId: "projectDeletions.get",
    method: "get",
    path: "/v1/projects/{projectId}/deletion-request",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "DeletionRequestResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "projectDeletions.cancel",
    method: "post",
    path: "/v1/projects/{projectId}/deletion-cancellations",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "DeletionCancellationRequest",
    successSchemaName: "DeletionRequestResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "projectKeys.publish",
    method: "put",
    path: "/v1/projects/{projectId}/keys/{keyVersion}",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "ProjectKeyPublishRequest",
    successSchemaName: "ProjectKeyResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "projectKeys.get",
    method: "get",
    path: "/v1/projects/{projectId}/keys/{keyVersion}",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "ProjectKeyResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "projectKeys.getCurrent",
    method: "get",
    path: "/v1/projects/{projectId}/keys/current",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "ProjectKeyResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "projects.getState",
    method: "get",
    path: "/v1/projects/{projectId}",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "ProjectStateResponse",
    successStatus: 200,
    queryParameters: [
      {
        name: "cursor",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 512 },
      },
    ],
  }),
  operation({
    operationId: "sync.push",
    method: "post",
    path: "/v1/projects/{projectId}/sync/push",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "SyncPushRequest",
    successSchemaName: "SyncPushResponse",
    successStatus: 200,
  }),
  operation({
    operationId: "sync.pull",
    method: "get",
    path: "/v1/projects/{projectId}/sync/pull",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "SyncPullResponse",
    successStatus: 200,
    queryParameters: [
      {
        name: "cursor",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 512 },
      },
      {
        name: "limit",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 256, default: 100 },
      },
    ],
  }),
  operation({
    operationId: "sync.snapshot",
    method: "get",
    path: "/v1/projects/{projectId}/sync/snapshot",
    requiresAuthentication: true,
    requiresIdempotencyKey: false,
    requestSchemaName: null,
    successSchemaName: "SyncSnapshotResponse",
    successStatus: 200,
    queryParameters: [
      {
        name: "cursor",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 512 },
      },
      {
        name: "limit",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 256, default: 100 },
      },
    ],
  }),
  operation({
    operationId: "sync.acknowledgeTombstones",
    method: "post",
    path: "/v1/projects/{projectId}/sync/tombstone-acknowledgements",
    requiresAuthentication: true,
    requiresIdempotencyKey: true,
    requestSchemaName: "TombstoneAcknowledgementRequest",
    successSchemaName: "MutationAcceptedResponse",
    successStatus: 202,
  }),
] as const;

export type CloudApiOperationId =
  | "aiBudgets.updateProject"
  | "aiBudgets.updateTeam"
  | "aiUsage.cancel"
  | "aiUsage.getSummary"
  | "aiUsage.listEvents"
  | "aiUsage.reserve"
  | "aiUsage.settle"
  | "accountDeletions.cancel"
  | "accountDeletions.lookup"
  | "accountDeletions.request"
  | "auth.listSessions"
  | "auth.login"
  | "auth.logout"
  | "auth.refresh"
  | "auth.revokeSession"
  | "devices.list"
  | "devices.register"
  | "devices.revoke"
  | "enterprisePolicies.evaluate"
  | "enterprisePolicies.get"
  | "enterprisePolicies.update"
  | "enterpriseSso.authorize"
  | "enterpriseSso.complete"
  | "enterpriseSso.getStatus"
  | "identity.confirmPasswordReset"
  | "identity.register"
  | "identity.requestPasswordReset"
  | "identity.verifyEmail"
  | "marketplace.appealVersion"
  | "marketplace.disposeAppeal"
  | "marketplace.disposeReport"
  | "marketplace.download"
  | "marketplace.listCatalog"
  | "marketplace.listModerationQueue"
  | "marketplace.moderateVersion"
  | "marketplace.reportVersion"
  | "marketplace.submitVersion"
  | "marketplace.withdrawVersion"
  | "projectAssignments.list"
  | "projectAssignments.set"
  | "reviewDecisions.create"
  | "reviews.get"
  | "reviews.list"
  | "reviews.submit"
  | "reviewSuggestionDecisions.create"
  | "reviewThreadItems.append"
  | "reviewThreadItems.list"
  | "reviewThreads.list"
  | "reviewThreads.resolve"
  | "projectKeys.get"
  | "projectKeys.getCurrent"
  | "projectKeys.publish"
  | "projectDeletions.cancel"
  | "projectDeletions.get"
  | "projectDeletions.request"
  | "projects.getState"
  | "sync.acknowledgeTombstones"
  | "sync.pull"
  | "sync.push"
  | "sync.snapshot"
  | "teamTemplateApplications.record"
  | "teamTemplateVersions.create"
  | "teamTemplateVersions.get"
  | "teamTemplateVersions.list"
  | "teamTemplates.archive"
  | "teamTemplates.clone"
  | "teamTemplates.create"
  | "teamTemplates.get"
  | "teamTemplates.list"
  | "teamTemplates.publish"
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

export const CLOUD_API_OPERATIONS: readonly CloudApiOperationDefinition[] = operationDefinitions;

export function getCloudApiOperation(
  operationId: CloudApiOperationId,
): CloudApiOperationDefinition {
  const definition = CLOUD_API_OPERATIONS.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (definition === undefined) {
    throw new Error(`Unknown InkShadow cloud API operation: ${operationId}`);
  }
  return definition;
}

export function getCloudApiComponentSchema<Name extends CloudApiComponentSchemaName>(
  name: Name,
): (typeof cloudApiComponentSchemas)[Name] {
  return cloudApiComponentSchemas[name];
}

function operation(
  value: Omit<CloudApiOperationDefinition, "operationId" | "requiresNativePasswordBoundary"> & {
    readonly operationId: CloudApiOperationId;
    readonly requiresNativePasswordBoundary?: boolean;
  },
): CloudApiOperationDefinition {
  return Object.freeze({
    ...value,
    requiresNativePasswordBoundary: value.requiresNativePasswordBoundary ?? false,
  });
}

function cursorQueryParameters(): readonly CloudApiQueryParameter[] {
  return [
    {
      name: "cursor",
      required: false,
      schema: { type: "string", minLength: 1, maxLength: 512 },
    },
    {
      name: "limit",
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 1_024, default: 100 },
    },
  ];
}

function reviewCursorQueryParameters(): readonly CloudApiQueryParameter[] {
  return [
    {
      name: "cursor",
      required: false,
      schema: { type: "string", minLength: 1, maxLength: 512 },
    },
    {
      name: "limit",
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
  ];
}

function usageEventQueryParameters(): readonly CloudApiQueryParameter[] {
  return [
    {
      name: "cursor",
      required: false,
      schema: { type: "string", minLength: 1, maxLength: 512 },
    },
    {
      name: "limit",
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
    {
      name: "projectId",
      required: false,
      schema: { type: "string", format: "uuid" },
    },
  ];
}

function marketplaceCatalogQueryParameters(): readonly CloudApiQueryParameter[] {
  return [
    ...marketplacePageQueryParameters(),
    {
      name: "kind",
      required: false,
      schema: {
        type: "string",
        enum: ["story_template", "style_template", "world_template"],
      },
    },
  ];
}

function marketplacePageQueryParameters(): readonly CloudApiQueryParameter[] {
  return [
    {
      name: "cursor",
      required: false,
      schema: { type: "string", minLength: 1, maxLength: 512 },
    },
    {
      name: "limit",
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
  ];
}
