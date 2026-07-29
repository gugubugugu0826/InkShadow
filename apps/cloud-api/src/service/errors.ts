import type { CloudApiErrorCode } from "@inkshadow/contracts";

export type CloudErrorAction =
  | "CONTACT_SUPPORT"
  | "EXPORT_DRAFT"
  | "OPEN_SETTINGS"
  | "REAUTHENTICATE"
  | "REDUCE_CONTEXT"
  | "RENAME"
  | "REQUEST_ACCESS"
  | "RESOLVE_CONFLICT"
  | "RESTORE"
  | "RETRY"
  | "SWITCH_MODEL"
  | "UPGRADE_CLIENT"
  | "USE_LOCAL";

export class CloudServiceError extends Error {
  public readonly actions: readonly CloudErrorAction[];
  public readonly code: CloudApiErrorCode;
  public readonly httpStatus: number;
  public readonly retryable: boolean;
  public readonly supportId: string | null;

  public constructor(options: {
    readonly actions?: readonly CloudErrorAction[];
    readonly code: CloudApiErrorCode;
    readonly httpStatus: number;
    readonly message: string;
    readonly retryable?: boolean;
    readonly supportId?: string | null;
  }) {
    super(options.message);
    this.name = "CloudServiceError";
    this.actions = options.actions ?? [];
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
    this.supportId = options.supportId ?? null;
  }
}

export function invalidCredentials(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY", "REAUTHENTICATE"],
    code: "AUTH_INVALID_CREDENTIALS",
    httpStatus: 401,
    message: "The email address or password is incorrect.",
  });
}

export function validationFailed(message: string): CloudServiceError {
  return new CloudServiceError({
    code: "VALIDATION_FAILED",
    httpStatus: 400,
    message,
  });
}

export function accessForbidden(
  message = "The requested action is not permitted.",
): CloudServiceError {
  return new CloudServiceError({
    actions: ["REQUEST_ACCESS"],
    code: "ACCESS_FORBIDDEN",
    httpStatus: 403,
    message,
  });
}

export function resourceNotFound(
  message = "The requested resource was not found.",
): CloudServiceError {
  return new CloudServiceError({
    code: "RESOURCE_NOT_FOUND",
    httpStatus: 404,
    message,
  });
}

export function idempotencyConflict(): CloudServiceError {
  return new CloudServiceError({
    code: "IDEMPOTENCY_CONFLICT",
    httpStatus: 409,
    message: "The idempotency key was already used for a different request.",
  });
}

export function sessionExpired(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REAUTHENTICATE"],
    code: "AUTH_SESSION_EXPIRED",
    httpStatus: 401,
    message: "The cloud session has expired.",
  });
}

export function sessionRevoked(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REAUTHENTICATE"],
    code: "AUTH_SESSION_REVOKED",
    httpStatus: 401,
    message: "The cloud session was revoked.",
  });
}

export function deviceRevoked(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REAUTHENTICATE"],
    code: "AUTH_DEVICE_REVOKED",
    httpStatus: 401,
    message: "This device was revoked.",
  });
}

export function accountLocked(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY", "CONTACT_SUPPORT"],
    code: "AUTH_ACCOUNT_LOCKED",
    httpStatus: 423,
    message: "The account is temporarily locked.",
    retryable: true,
  });
}

export function accountFrozen(): CloudServiceError {
  return new CloudServiceError({
    actions: ["CONTACT_SUPPORT"],
    code: "AUTH_ACCOUNT_FROZEN",
    httpStatus: 403,
    message: "The account is currently unavailable.",
  });
}

export function upgradeRequired(): CloudServiceError {
  return new CloudServiceError({
    actions: ["UPGRADE_CLIENT"],
    code: "AUTH_UPGRADE_REQUIRED",
    httpStatus: 426,
    message: "Update InkShadow before using cloud services.",
  });
}

export function emailUnverified(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REAUTHENTICATE"],
    code: "AUTH_EMAIL_UNVERIFIED",
    httpStatus: 403,
    message: "Verify the email address before signing in.",
  });
}

export function refreshReplayed(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REAUTHENTICATE", "CONTACT_SUPPORT"],
    code: "AUTH_REFRESH_REPLAYED",
    httpStatus: 401,
    message: "Refresh-token replay was detected and this device was signed out.",
  });
}

export function serviceUnavailable(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY", "USE_LOCAL"],
    code: "SERVICE_UNAVAILABLE",
    httpStatus: 503,
    message: "The cloud service is temporarily unavailable.",
    retryable: true,
  });
}

export function revisionConflict(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY", "RESOLVE_CONFLICT"],
    code: "REVISION_CONFLICT",
    httpStatus: 409,
    message: "The cloud project changed before this request was applied.",
    retryable: true,
  });
}

export function syncCursorExpired(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY"],
    code: "SYNC_CURSOR_EXPIRED",
    httpStatus: 409,
    message: "The sync cursor is invalid or no longer available.",
    retryable: true,
  });
}

export function syncSequenceConflict(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY", "RESOLVE_CONFLICT"],
    code: "SYNC_SEQUENCE_CONFLICT",
    httpStatus: 409,
    message: "The device sync sequence conflicts with cloud history.",
    retryable: true,
  });
}

export function invalidCiphertext(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY", "CONTACT_SUPPORT"],
    code: "SYNC_INVALID_CIPHERTEXT",
    httpStatus: 400,
    message: "Ciphertext metadata or integrity verification failed.",
  });
}

export function aiBudgetNotConfigured(): CloudServiceError {
  return new CloudServiceError({
    actions: ["OPEN_SETTINGS", "USE_LOCAL"],
    code: "AI_BUDGET_NOT_CONFIGURED",
    httpStatus: 409,
    message: "A team AI budget must be configured before reserving cloud AI usage.",
  });
}

export function aiBudgetHardCap(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REDUCE_CONTEXT", "OPEN_SETTINGS", "USE_LOCAL"],
    code: "AI_BUDGET_HARD_CAP",
    httpStatus: 409,
    message: "The requested cloud AI usage would exceed an authoritative monthly hard cap.",
  });
}

export function aiBudgetCurrencyLocked(): CloudServiceError {
  return new CloudServiceError({
    actions: ["OPEN_SETTINGS", "RETRY"],
    code: "AI_BUDGET_CURRENCY_LOCKED",
    httpStatus: 409,
    message:
      "The team budget currency cannot change while the current month has usage or an active lease.",
    retryable: false,
  });
}

export function aiConcurrencyHardCap(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY", "USE_LOCAL"],
    code: "AI_CONCURRENCY_HARD_CAP",
    httpStatus: 409,
    message: "The team has reached its authoritative concurrent cloud AI run limit.",
    retryable: true,
  });
}

export function aiPriceVersionMismatch(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY", "OPEN_SETTINGS", "USE_LOCAL"],
    code: "AI_PRICE_VERSION_MISMATCH",
    httpStatus: 409,
    message: "The AI price version changed before usage could be reserved.",
    retryable: true,
  });
}

export function aiReservationExpired(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY", "USE_LOCAL"],
    code: "AI_RESERVATION_EXPIRED",
    httpStatus: 409,
    message: "The cloud AI usage reservation lease expired.",
    retryable: true,
  });
}

export function aiReservationStateConflict(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY", "RESOLVE_CONFLICT", "USE_LOCAL"],
    code: "AI_RESERVATION_STATE_CONFLICT",
    httpStatus: 409,
    message: "The cloud AI usage reservation is no longer in the requested state.",
  });
}

export function enterpriseLicenseRequired(): CloudServiceError {
  return new CloudServiceError({
    actions: ["CONTACT_SUPPORT", "USE_LOCAL"],
    code: "ENTERPRISE_LICENSE_REQUIRED",
    httpStatus: 503,
    message: "A verified Enterprise deployment license is required for this operation.",
  });
}

export function enterpriseLicenseInvalid(): CloudServiceError {
  return new CloudServiceError({
    actions: ["CONTACT_SUPPORT", "USE_LOCAL"],
    code: "ENTERPRISE_LICENSE_INVALID",
    httpStatus: 503,
    message: "The Enterprise deployment license is expired or invalid.",
  });
}

export function enterprisePolicyRequired(): CloudServiceError {
  return new CloudServiceError({
    actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
    code: "ENTERPRISE_POLICY_REQUIRED",
    httpStatus: 409,
    message: "An Enterprise organization policy must be configured before this operation.",
  });
}

export function enterprisePolicyDenied(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REQUEST_ACCESS", "OPEN_SETTINGS"],
    code: "ENTERPRISE_POLICY_DENIED",
    httpStatus: 403,
    message: "The organization policy does not permit this operation.",
  });
}

export function ssoRequired(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REAUTHENTICATE", "USE_LOCAL"],
    code: "SSO_REQUIRED",
    httpStatus: 403,
    message: "This organization requires sign-in through its identity provider.",
  });
}

export function ssoNotConfigured(): CloudServiceError {
  return new CloudServiceError({
    actions: ["CONTACT_SUPPORT", "USE_LOCAL"],
    code: "SSO_NOT_CONFIGURED",
    httpStatus: 503,
    message: "Enterprise SSO is not configured for this organization.",
  });
}

export function ssoStateInvalid(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REAUTHENTICATE"],
    code: "SSO_STATE_INVALID",
    httpStatus: 400,
    message: "The SSO callback did not match the authorization session.",
  });
}

export function ssoFlowExpired(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REAUTHENTICATE"],
    code: "SSO_FLOW_EXPIRED",
    httpStatus: 410,
    message: "The SSO authorization session expired. Start sign-in again.",
  });
}

export function ssoFlowReplayed(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REAUTHENTICATE", "CONTACT_SUPPORT"],
    code: "SSO_FLOW_REPLAYED",
    httpStatus: 409,
    message: "The SSO authorization session was already consumed.",
  });
}

export function ssoCallbackInProgress(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY"],
    code: "SSO_CALLBACK_IN_PROGRESS",
    httpStatus: 409,
    message: "This SSO callback is already being processed.",
    retryable: true,
  });
}

export function ssoProviderUnavailable(): CloudServiceError {
  return new CloudServiceError({
    actions: ["RETRY", "USE_LOCAL", "CONTACT_SUPPORT"],
    code: "SSO_PROVIDER_UNAVAILABLE",
    httpStatus: 503,
    message: "The organization identity provider could not be reached.",
    retryable: true,
  });
}

export function ssoTokenInvalid(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REAUTHENTICATE", "CONTACT_SUPPORT"],
    code: "SSO_TOKEN_INVALID",
    httpStatus: 401,
    message: "The identity provider response could not be verified.",
  });
}

export function ssoDomainForbidden(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REQUEST_ACCESS", "REAUTHENTICATE"],
    code: "SSO_DOMAIN_FORBIDDEN",
    httpStatus: 403,
    message: "The identity provider account is outside the organization's allowed domains.",
  });
}

export function ssoMembershipRequired(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REQUEST_ACCESS", "REAUTHENTICATE"],
    code: "SSO_MEMBERSHIP_REQUIRED",
    httpStatus: 403,
    message: "An active organization membership is required for SSO.",
  });
}

export function ssoDeviceNotApproved(): CloudServiceError {
  return new CloudServiceError({
    actions: ["REQUEST_ACCESS", "OPEN_SETTINGS"],
    code: "SSO_DEVICE_NOT_APPROVED",
    httpStatus: 403,
    message: "This device is not approved by the organization policy.",
  });
}
