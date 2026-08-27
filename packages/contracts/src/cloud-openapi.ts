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
  operation([
    "accountDeletions.request",
    "post",
    "/v1/account/deletion-requests",
    "AccountDeletionSubmissionRequest",
    "DeletionRequestResponse",
    202,
    7,
    "Schedules permanent account deletion after the bearer account, canonical email and password all match. A successful response means every account session has already been revoked; later lookup and cancellation use the deletion proof without bearer authentication.",
  ]),
  operation([
    "accountDeletions.lookup",
    "post",
    "/v1/account/deletion-request-lookups",
    "AccountDeletionLookupRequest",
    "DeletionRequestResponse",
    200,
    4,
    "Looks up an account deletion after session revocation using email, password and exactly one of deletionRequestId or the original confirmationId. Unknown requests and invalid credentials have indistinguishable errors.",
  ]),
  operation([
    "accountDeletions.cancel",
    "post",
    "/v1/account/deletion-cancellations",
    "AccountDeletionCancellationRequest",
    "DeletionRequestResponse",
    200,
    6,
    "Cancels an account deletion after session revocation using email, password and deletionRequestId. Unknown requests and invalid credentials have indistinguishable errors.",
  ]),
  operation([
    "identity.register",
    "post",
    "/v1/identity/registrations",
    "IdentityRegistrationRequest",
    "IdentityChallengeResponse",
    202,
    2,
  ]),
  operation([
    "identity.verifyEmail",
    "post",
    "/v1/identity/verifications",
    "IdentityVerificationRequest",
    "SessionGrantResponse",
    200,
    2,
  ]),
  operation([
    "identity.requestPasswordReset",
    "post",
    "/v1/identity/password-resets",
    "PasswordResetRequest",
    "IdentityChallengeResponse",
    202,
    2,
  ]),
  operation([
    "identity.confirmPasswordReset",
    "post",
    "/v1/identity/password-resets/confirmations",
    "PasswordResetConfirmationRequest",
    "MutationAcceptedResponse",
    202,
    2,
  ]),
  operation([
    "auth.login",
    "post",
    "/v1/auth/sessions",
    "AuthenticationRequest",
    "SessionGrantResponse",
    200,
    2,
  ]),
  operation([
    "auth.refresh",
    "post",
    "/v1/auth/session-rotations",
    "SessionRefreshRequest",
    "SessionGrantResponse",
    200,
    2,
  ]),
  operation([
    "auth.logout",
    "post",
    "/v1/auth/session-revocations",
    "SessionLogoutRequest",
    "MutationAcceptedResponse",
    202,
    3,
  ]),
  operation([
    "auth.listSessions",
    "get",
    "/v1/auth/sessions",
    null,
    "SessionListResponse",
    200,
    1,
    cursorQueryParameters(),
  ]),
  operation([
    "auth.revokeSession",
    "delete",
    "/v1/auth/sessions/{sessionId}",
    null,
    "MutationAcceptedResponse",
    202,
    3,
  ]),
  operation([
    "devices.list",
    "get",
    "/v1/devices",
    null,
    "DeviceListResponse",
    200,
    1,
    cursorQueryParameters(),
  ]),
  operation([
    "devices.register",
    "post",
    "/v1/devices",
    "DeviceRegistrationRequest",
    "DeviceResponse",
    201,
    3,
  ]),
  operation(["devices.revoke", "delete", "/v1/devices/{deviceId}", null, "DeviceResponse", 200, 3]),
  operation(["teams.create", "post", "/v1/teams", "TeamCreateRequest", "TeamResponse", 201, 3]),
  operation([
    "teams.list",
    "get",
    "/v1/teams",
    null,
    "TeamListResponse",
    200,
    1,
    cursorQueryParameters(),
  ]),
  operation([
    "teamMembers.list",
    "get",
    "/v1/teams/{teamId}/members",
    null,
    "TeamMemberListResponse",
    200,
    1,
    cursorQueryParameters(),
  ]),
  operation([
    "teamInvitations.create",
    "post",
    "/v1/teams/{teamId}/invitations",
    "TeamInvitationCreateRequest",
    "TeamInvitationResponse",
    201,
    3,
  ]),
  operation([
    "teamInvitations.accept",
    "post",
    "/v1/team-invitations/{invitationId}/acceptances",
    "TeamInvitationAcceptRequest",
    "TeamInvitationAcceptanceResponse",
    200,
    3,
  ]),
  operation([
    "teamMembers.changeRole",
    "post",
    "/v1/teams/{teamId}/members/{membershipId}/role-changes",
    "TeamMemberRoleChangeRequest",
    "TeamMembershipResponse",
    200,
    3,
  ]),
  operation([
    "teamMembers.revoke",
    "post",
    "/v1/teams/{teamId}/members/{membershipId}/revocations",
    "TeamMembershipRevokeRequest",
    "TeamMembershipResponse",
    200,
    3,
  ]),
  operation([
    "projectAssignments.list",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/assignments",
    null,
    "ProjectAssignmentListResponse",
    200,
    1,
    cursorQueryParameters(),
  ]),
  operation([
    "projectAssignments.set",
    "put",
    "/v1/teams/{teamId}/projects/{projectId}/assignments/{membershipId}",
    "ProjectAssignmentSetRequest",
    "ProjectAssignmentResponse",
    200,
    3,
  ]),
  operation([
    "enterprisePolicies.get",
    "get",
    "/v1/teams/{teamId}/enterprise/policy",
    null,
    "EnterprisePolicyResponse",
    200,
    1,
    "Returns the authoritative, tenant-scoped organization policy. The route fails closed when the deployment license or policy is unavailable.",
  ]),
  operation([
    "enterprisePolicies.update",
    "put",
    "/v1/teams/{teamId}/enterprise/policy",
    "EnterprisePolicyUpdateRequest",
    "EnterprisePolicyResponse",
    200,
    3,
    "Creates or revision-updates organization SSO, session, device, export, external-egress and support governance. Only team owners and administrators may mutate policy.",
  ]),
  operation([
    "enterprisePolicies.evaluate",
    "post",
    "/v1/teams/{teamId}/enterprise/policy-evaluations",
    "EnterprisePolicyEvaluationRequest",
    "EnterprisePolicyEvaluationResponse",
    200,
    3,
    "Evaluates the current principal, device and requested governed action against the authoritative organization policy without mutating policy state.",
  ]),
  operation([
    "enterpriseSso.getStatus",
    "get",
    "/v1/teams/{teamId}/enterprise/sso",
    null,
    "EnterpriseSsoStatusResponse",
    200,
    1,
    "Returns non-secret OIDC configuration status for an authorized organization administrator. Client secrets, discovery documents and keys are never returned.",
  ]),
  operation([
    "enterpriseSso.authorize",
    "post",
    "/v1/enterprise/sso/authorizations",
    "EnterpriseSsoAuthorizationRequest",
    "EnterpriseSsoAuthorizationResponse",
    201,
    2,
    "Creates a one-time OIDC authorization flow bound to the team, exact redirect URI and exact device identity. State, nonce and S256 PKCE values are server-derived from a client-held flow secret.",
  ]),
  operation([
    "enterpriseSso.complete",
    "post",
    "/v1/enterprise/sso/callbacks",
    "EnterpriseSsoCallbackRequest",
    "EnterpriseSsoSessionResponse",
    200,
    2,
    "Consumes a one-time OIDC callback after exact state, redirect, device, PKCE, nonce, issuer, audience, signature, domain and membership validation, then issues a device-bound InkShadow session.",
  ]),
  operation([
    "aiBudgets.updateTeam",
    "put",
    "/v1/teams/{teamId}/ai-budget",
    "AiTeamBudgetUpdateRequest",
    "AiTeamBudgetResponse",
    200,
    3,
    "Creates or revision-updates the authoritative monthly team AI hard cap and token price version. Owner, admin or the explicit billing.manage capability is required.",
  ]),
  operation([
    "aiBudgets.updateProject",
    "put",
    "/v1/teams/{teamId}/projects/{projectId}/ai-budget",
    "AiProjectBudgetUpdateRequest",
    "AiProjectBudgetResponse",
    200,
    3,
    "Creates or revision-updates an optional project hard cap under the authoritative team cap. A null limit disables the project-specific cap without deleting history.",
  ]),
  operation([
    "aiUsage.getSummary",
    "get",
    "/v1/teams/{teamId}/ai-usage",
    null,
    "AiUsageSummaryResponse",
    200,
    1,
    "Returns settled and currently reserved metadata-only AI usage for the authorized team or project month, after reclaiming expired leases.",
    [
      {
        name: "projectId",
        required: false,
        schema: { type: "string", format: "uuid" },
      },
    ],
  ]),
  operation([
    "aiUsage.listEvents",
    "get",
    "/v1/teams/{teamId}/ai-usage/events",
    null,
    "AiUsageEventListResponse",
    200,
    1,
    "Lists append-only metadata-only reservation, settlement, cancellation and lease-expiry events. Creative content, prompts, keys and ciphertext are never accepted or returned.",
    usageEventQueryParameters(),
  ]),
  operation([
    "aiUsage.reserve",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/ai-usage/reservations",
    "AiUsageReservationRequest",
    "AiUsageReservationResponse",
    201,
    3,
    "Atomically reserves team and optional project budget using server-owned token prices and a bounded lease. Concurrent calls cannot cross the hard cap.",
  ]),
  operation([
    "aiUsage.settle",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/ai-usage/reservations/{reservationId}/settlements",
    "AiUsageSettlementRequest",
    "AiUsageReservationResponse",
    200,
    3,
    "Settles actual token usage no greater than the active reservation. Exact replay converges through idempotency and revision checks.",
  ]),
  operation([
    "aiUsage.cancel",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/ai-usage/reservations/{reservationId}/cancellations",
    "AiUsageCancellationRequest",
    "AiUsageReservationResponse",
    200,
    3,
    "Cancels an active reservation and releases its capacity. Exact replay converges and terminal reservations cannot be changed.",
  ]),
  operation([
    "teamProjectKeys.getCurrent",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/keys/current",
    null,
    "TeamProjectCurrentKeyResponse",
    200,
    1,
    "Returns only the authoritative active team-project key version and whether an active envelope exists for the authenticated session device. Active membership, exact active project assignment and project.read authorization are required; no ciphertext, public keys, recovery material or other recipients are returned.",
  ]),
  operation([
    "teamProjectKeyRecipients.list",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/keys/{keyVersion}/recipients",
    null,
    "TeamProjectKeyEligibleRecipientListResponse",
    200,
    1,
    "Lists only trusted devices belonging to active team memberships with active project assignments. The response contains public key material and exact membership/assignment revisions, but no envelopes, invitation credentials or recovery ciphertext.",
  ]),
  operation([
    "teamProjectKeyEnvelopes.publish",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/keys/{keyVersion}/envelopes",
    "TeamProjectKeyEnvelopePublishRequest",
    "TeamProjectKeyEnvelopeResponse",
    201,
    3,
    "Publishes one client-created HPKE envelope after exact team, project, key, membership, assignment, device and public-key-fingerprint checks. Stable idempotency is mandatory.",
  ]),
  operation([
    "teamProjectKeyEnvelopes.getCurrentDevice",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/keys/{keyVersion}/envelopes/current-device",
    null,
    "TeamProjectKeyEnvelopeResponse",
    200,
    1,
    "Returns exactly the authenticated session device's own active team-project key envelope. Other recipient ciphertexts are never included.",
  ]),
  operation([
    "reviews.submit",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/reviews",
    "ReviewSubmissionRequest",
    "ReviewResponse",
    201,
    3,
    "Submits an immutable, exact source-version review envelope. The server stores opaque AES-GCM ciphertext and version/key metadata only.",
  ]),
  operation([
    "reviews.list",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/reviews",
    null,
    "ReviewListResponse",
    200,
    1,
    reviewCursorQueryParameters(),
  ]),
  operation([
    "reviews.get",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}",
    null,
    "ReviewResponse",
    200,
    1,
  ]),
  operation([
    "reviewDecisions.create",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/decisions",
    "ReviewDecisionRequest",
    "ReviewResponse",
    200,
    3,
    "Approves or rejects an immutable submitted version with an exact expected revision. It never writes project content.",
  ]),
  operation([
    "reviewThreadItems.append",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/thread-items",
    "ReviewThreadItemAppendRequest",
    "ReviewThreadItemResponse",
    201,
    3,
    "Creates an encrypted comment, suggestion, question or rewrite-request thread, or appends an encrypted reply under exact thread CAS.",
  ]),
  operation([
    "reviewThreads.list",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/threads",
    null,
    "ReviewThreadListResponse",
    200,
    1,
    reviewCursorQueryParameters(),
  ]),
  operation([
    "reviewThreadItems.list",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/threads/{threadId}/items",
    null,
    "ReviewThreadItemListResponse",
    200,
    1,
    reviewCursorQueryParameters(),
  ]),
  operation([
    "reviewThreads.resolve",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/threads/{threadId}/resolutions",
    "ReviewThreadResolutionRequest",
    "ReviewThreadResponse",
    200,
    3,
  ]),
  operation([
    "reviewSuggestionDecisions.create",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/reviews/{reviewId}/threads/{threadId}/suggestions/{itemId}/decisions",
    "ReviewSuggestionDecisionRequest",
    "ReviewSuggestionDecisionResponse",
    200,
    3,
    "Records author-side acceptance or rejection metadata for an encrypted suggestion. The operation cannot mutate formal content.",
  ]),
  operation([
    "teamTemplates.create",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/templates",
    "TeamTemplateCreateRequest",
    "TeamTemplateMutationResponse",
    201,
    3,
    "Creates a project-bound draft template and immutable encrypted version 1. Only opaque project-DEK ciphertext and public AEAD binding metadata reach the service.",
  ]),
  operation([
    "teamTemplates.list",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/templates",
    null,
    "TeamTemplateListResponse",
    200,
    1,
    "Lists only non-sensitive lifecycle metadata for templates in one actively assigned team project.",
    reviewCursorQueryParameters(),
  ]),
  operation([
    "teamTemplates.get",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}",
    null,
    "TeamTemplateResponse",
    200,
    1,
  ]),
  operation([
    "teamTemplateVersions.create",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/versions",
    "TeamTemplateVersionCreateRequest",
    "TeamTemplateMutationResponse",
    201,
    3,
    "Appends one immutable ciphertext version to a draft under exact template revision CAS. Published and archived templates cannot be changed in place.",
  ]),
  operation([
    "teamTemplateVersions.list",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/versions",
    null,
    "TeamTemplateVersionListResponse",
    200,
    1,
    reviewCursorQueryParameters(),
  ]),
  operation([
    "teamTemplateVersions.get",
    "get",
    "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/versions/{versionId}",
    null,
    "TeamTemplateVersionResponse",
    200,
    1,
  ]),
  operation([
    "teamTemplates.clone",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/clones",
    "TeamTemplateCloneRequest",
    "TeamTemplateMutationResponse",
    201,
    3,
    "Creates a new draft from a readable same-project source version. The client must decrypt and re-encrypt for the new immutable target AAD.",
  ]),
  operation([
    "teamTemplates.publish",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/publications",
    "TeamTemplatePublishRequest",
    "TeamTemplateResponse",
    200,
    3,
    "Publishes the exact latest immutable draft version under revision CAS. Owner or admin authorization is required.",
  ]),
  operation([
    "teamTemplates.archive",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/archives",
    "TeamTemplateArchiveRequest",
    "TeamTemplateResponse",
    200,
    3,
    "Archives a draft or published template under revision CAS while preserving immutable history for authorized reads and exports.",
  ]),
  operation([
    "teamTemplateApplications.record",
    "post",
    "/v1/teams/{teamId}/projects/{projectId}/templates/{templateId}/applications",
    "TeamTemplateApplyRequest",
    "TeamTemplateApplicationResponse",
    201,
    3,
    "Records metadata only after a client has atomically and idempotently applied a decrypted template locally. The server never mutates project content.",
  ]),
  operation([
    "marketplace.listCatalog",
    "get",
    "/v1/marketplace/artifacts",
    null,
    "MarketplaceCatalogResponse",
    200,
    1,
    "Lists only published structured community artifacts. The feature is server-gated and installed local copies remain independent of this service.",
    marketplaceCatalogQueryParameters(),
  ]),
  operation([
    "marketplace.submitVersion",
    "post",
    "/v1/marketplace/artifacts/submissions",
    "MarketplaceSubmissionRequest",
    "MarketplaceSubmissionResponse",
    201,
    3,
    "Submits a data-only structured artifact whose digest and Ed25519 author signature are bound to the exact canonical payload.",
  ]),
  operation([
    "marketplace.moderateVersion",
    "post",
    "/v1/marketplace/artifacts/{artifactId}/versions/{versionId}/moderation",
    "MarketplaceModerationRequest",
    "MarketplaceSubmissionResponse",
    200,
    3,
    "Performs a high-risk moderation transition. Platform-operations authorization, strong MFA, an explicit reason and exact confirmation are required by the service.",
  ]),
  operation([
    "marketplace.reportVersion",
    "post",
    "/v1/marketplace/artifacts/{artifactId}/versions/{versionId}/reports",
    "MarketplaceReportRequest",
    "MarketplaceReportResponse",
    201,
    3,
  ]),
  operation([
    "marketplace.withdrawVersion",
    "post",
    "/v1/marketplace/artifacts/{artifactId}/versions/{versionId}/withdrawals",
    "MarketplaceWithdrawalRequest",
    "MarketplaceSubmissionResponse",
    200,
    3,
  ]),
  operation([
    "marketplace.appealVersion",
    "post",
    "/v1/marketplace/artifacts/{artifactId}/versions/{versionId}/appeals",
    "MarketplaceAppealRequest",
    "MarketplaceAppealResponse",
    201,
    3,
  ]),
  operation([
    "marketplace.disposeReport",
    "post",
    "/v1/marketplace/reports/{reportId}/dispositions",
    "MarketplaceReportDispositionRequest",
    "MarketplaceReportResponse",
    200,
    3,
    "Disposes a report under platform-operations authorization, strong MFA and exact high-risk confirmation.",
  ]),
  operation([
    "marketplace.disposeAppeal",
    "post",
    "/v1/marketplace/appeals/{appealId}/dispositions",
    "MarketplaceAppealDispositionRequest",
    "MarketplaceAppealResponse",
    200,
    3,
    "Disposes an appeal under platform-operations authorization, strong MFA and exact high-risk confirmation.",
  ]),
  operation([
    "marketplace.download",
    "post",
    "/v1/marketplace/artifacts/{artifactId}/downloads",
    "MarketplaceDownloadRequest",
    "MarketplaceDownloadResponse",
    200,
    3,
    "Returns the exact published structured payload together with its author public key, signature and immutable audit receipt.",
  ]),
  operation([
    "marketplace.listModerationQueue",
    "get",
    "/v1/marketplace/moderation/queue",
    null,
    "MarketplaceModerationQueueResponse",
    200,
    1,
    "Lists the moderation queue only for a strongly authenticated platform-operations principal.",
    marketplacePageQueryParameters(),
  ]),
  operation([
    "projectDeletions.request",
    "post",
    "/v1/projects/{projectId}/deletion-requests",
    "DeletionSubmissionRequest",
    "DeletionRequestResponse",
    202,
    7,
  ]),
  operation([
    "projectDeletions.get",
    "get",
    "/v1/projects/{projectId}/deletion-request",
    null,
    "DeletionRequestResponse",
    200,
    1,
  ]),
  operation([
    "projectDeletions.cancel",
    "post",
    "/v1/projects/{projectId}/deletion-cancellations",
    "DeletionCancellationRequest",
    "DeletionRequestResponse",
    200,
    3,
  ]),
  operation([
    "projectKeys.publish",
    "put",
    "/v1/projects/{projectId}/keys/{keyVersion}",
    "ProjectKeyPublishRequest",
    "ProjectKeyResponse",
    200,
    3,
  ]),
  operation([
    "projectKeys.get",
    "get",
    "/v1/projects/{projectId}/keys/{keyVersion}",
    null,
    "ProjectKeyResponse",
    200,
    1,
  ]),
  operation([
    "projectKeys.getCurrent",
    "get",
    "/v1/projects/{projectId}/keys/current",
    null,
    "ProjectKeyResponse",
    200,
    1,
  ]),
  operation([
    "projects.getState",
    "get",
    "/v1/projects/{projectId}",
    null,
    "ProjectStateResponse",
    200,
    1,
    [
      {
        name: "cursor",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 512 },
      },
    ],
  ]),
  operation([
    "sync.push",
    "post",
    "/v1/projects/{projectId}/sync/push",
    "SyncPushRequest",
    "SyncPushResponse",
    200,
    3,
  ]),
  operation([
    "sync.pull",
    "get",
    "/v1/projects/{projectId}/sync/pull",
    null,
    "SyncPullResponse",
    200,
    1,
    [
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
  ]),
  operation([
    "sync.snapshot",
    "get",
    "/v1/projects/{projectId}/sync/snapshot",
    null,
    "SyncSnapshotResponse",
    200,
    1,
    [
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
  ]),
  operation([
    "sync.acknowledgeTombstones",
    "post",
    "/v1/projects/{projectId}/sync/tombstone-acknowledgements",
    "TombstoneAcknowledgementRequest",
    "MutationAcceptedResponse",
    202,
    3,
  ]),
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

type CloudApiOperationFlags = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

type CompactCloudApiOperation = readonly [
  operationId: CloudApiOperationId,
  method: CloudApiHttpMethod,
  path: string,
  requestSchemaName: CloudApiComponentSchemaName | null,
  successSchemaName: CloudApiComponentSchemaName,
  successStatus: number,
  flags: CloudApiOperationFlags,
  descriptionOrQueryParameters?: string | readonly CloudApiQueryParameter[],
  queryParametersAfterDescription?: readonly CloudApiQueryParameter[],
];

function operation(value: CompactCloudApiOperation): CloudApiOperationDefinition {
  const [
    operationId,
    method,
    path,
    requestSchemaName,
    successSchemaName,
    successStatus,
    flags,
    descriptionOrQueryParameters,
    queryParametersAfterDescription,
  ] = value;
  const description =
    typeof descriptionOrQueryParameters === "string" ? descriptionOrQueryParameters : undefined;
  const queryParameters =
    typeof descriptionOrQueryParameters === "string"
      ? queryParametersAfterDescription
      : descriptionOrQueryParameters;
  const requiresNativePasswordBoundary = (flags & 4) !== 0;
  const definition = {
    operationId,
    ...(description === undefined ? {} : { description }),
    method,
    path,
    requiresAuthentication: (flags & 1) !== 0,
    requiresIdempotencyKey: (flags & 2) !== 0,
    ...(requiresNativePasswordBoundary ? { requiresNativePasswordBoundary: true } : {}),
    requestSchemaName,
    successSchemaName,
    successStatus,
    ...(queryParameters === undefined ? {} : { queryParameters }),
  };
  if (requiresNativePasswordBoundary) {
    return Object.freeze(definition) as CloudApiOperationDefinition;
  }
  return Object.freeze({ ...definition, requiresNativePasswordBoundary: false });
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
