use std::{
    collections::{BTreeMap, HashSet},
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use bytes::Bytes;
use hpke::{kem::DhP256HkdfSha256, Deserializable, Kem as KemTrait};
use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    Client, Method, Response, StatusCode, Url,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use uuid::{Uuid, Variant as UuidVariant, Version as UuidVersion};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    credential_service,
    model_gateway::CommandError,
    network_egress::{
        host_is_explicit_loopback, host_is_ip_literal, literal_ip_is_allowed, RestrictedDnsResolver,
    },
    project_keys::{
        accept_current_device_team_project_key_envelope, inspect_team_project_key_receipt,
        load_device_identity_summary, open_team_project_key_receipt,
        remove_team_project_key_receipt_if_current, DeviceIdentitySummary, ProjectDataKeyMaterial,
        ProjectKeyVaultState, TeamProjectKeyEnvelope, TeamProjectKeyEnvelopeExpectation,
        TeamProjectKeyReceiptBinding, TeamProjectKeyReceiptCommit, TeamProjectKeyReceiptRemoval,
        TeamProjectKeyReceiptStatus,
    },
};

type DeviceKem = DhP256HkdfSha256;
type DevicePublicKey = <DeviceKem as KemTrait>::PublicKey;

const CLOUD_SESSION_ACCOUNT: &str = "cloud:active-session";
const STORED_SESSION_PREFIX: &str = "inkshadow-cloud-session-v2:";
const CLOUD_SCHEMA_VERSION: u8 = 1;
const STORED_SCHEMA_VERSION: u8 = 2;
const DEVICE_KEY_ALGORITHM: &str = "DHKEM-P256-HKDF-SHA256";
const MAX_TOKEN_BYTES: usize = 4_096;
const MAX_BASE_URL_BYTES: usize = 2_048;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_STORED_SESSION_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PORTABLE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_TEAM_PROJECT_CURRENT_KEY_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_TEAM_PROJECT_KEY_ENVELOPE_RESPONSE_BYTES: usize = 32 * 1024;

#[derive(Default)]
pub(crate) struct CloudSessionVaultState {
    vault_guard: Mutex<()>,
    mutation_guard: tokio::sync::Mutex<()>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloudEndpointInput {
    base_url: String,
    #[serde(default)]
    allow_insecure_loopback: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloudDeviceInput {
    device_id: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloudLoginInput {
    endpoint: CloudEndpointInput,
    email: String,
    password: String,
    device: CloudDeviceInput,
}

impl Drop for CloudLoginInput {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloudEmailVerificationInput {
    endpoint: CloudEndpointInput,
    challenge_id: String,
    code: String,
    device: CloudDeviceInput,
}

impl Drop for CloudEmailVerificationInput {
    fn drop(&mut self) {
        self.code.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloudSessionMutationInput {
    expected_session_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub(crate) enum CloudRelayMethod {
    Get,
    Post,
    Put,
    Delete,
}

impl CloudRelayMethod {
    fn as_reqwest(self) -> Method {
        match self {
            Self::Get => Method::GET,
            Self::Post => Method::POST,
            Self::Put => Method::PUT,
            Self::Delete => Method::DELETE,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CloudRelayAuthentication {
    None,
    Session,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendCloudApiRequestInput {
    base_url: String,
    #[serde(default)]
    allow_insecure_loopback: bool,
    method: CloudRelayMethod,
    path: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: serde_json::Value,
    authentication: CloudRelayAuthentication,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AcceptCurrentDeviceTeamProjectKeyEnvelopeInput {
    team_id: String,
    project_id: String,
    expected_session_id: String,
    expected_account_id: String,
    expected_device_id: String,
    expected_recipient_public_key: String,
    expected_recipient_public_key_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamProjectKeyReceiptAccessInput {
    expected_session_id: Option<String>,
    receipt: TeamProjectKeyReceiptBinding,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloudTeamProjectCurrentKeyResponse {
    schema_version: u8,
    request_id: String,
    team_id: String,
    project_id: String,
    key_version: u32,
    state: String,
    server_revision: u64,
    updated_at: String,
    current_device_envelope_available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloudTeamProjectKeyEnvelopeResponse {
    schema_version: u8,
    request_id: String,
    envelope: TeamProjectKeyEnvelope,
}

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CloudDeletionCredentialInput {
    RequestProject {
        base_url: String,
        #[serde(default)]
        allow_insecure_loopback: bool,
        project_id: String,
        request_id: String,
        idempotency_key: String,
        expected_revision: u64,
        confirmation_id: String,
        password: String,
    },
    RequestAccount {
        base_url: String,
        #[serde(default)]
        allow_insecure_loopback: bool,
        request_id: String,
        idempotency_key: String,
        expected_revision: u64,
        confirmation_id: String,
        email: String,
        password: String,
    },
    LookupAccount {
        base_url: String,
        #[serde(default)]
        allow_insecure_loopback: bool,
        request_id: String,
        deletion_request_id: Option<String>,
        confirmation_id: Option<String>,
        email: String,
        password: String,
    },
    CancelAccount {
        base_url: String,
        #[serde(default)]
        allow_insecure_loopback: bool,
        request_id: String,
        idempotency_key: String,
        deletion_request_id: String,
        expected_deletion_revision: u64,
        email: String,
        password: String,
    },
}

impl CloudDeletionCredentialInput {
    fn endpoint(&self) -> CloudEndpointInput {
        let (base_url, allow_insecure_loopback) = match self {
            Self::RequestProject {
                base_url,
                allow_insecure_loopback,
                ..
            }
            | Self::RequestAccount {
                base_url,
                allow_insecure_loopback,
                ..
            }
            | Self::LookupAccount {
                base_url,
                allow_insecure_loopback,
                ..
            }
            | Self::CancelAccount {
                base_url,
                allow_insecure_loopback,
                ..
            } => (base_url, *allow_insecure_loopback),
        };
        CloudEndpointInput {
            base_url: base_url.clone(),
            allow_insecure_loopback,
        }
    }

    fn password_mut(&mut self) -> &mut String {
        match self {
            Self::RequestProject { password, .. }
            | Self::RequestAccount { password, .. }
            | Self::LookupAccount { password, .. }
            | Self::CancelAccount { password, .. } => password,
        }
    }
}

impl Drop for CloudDeletionCredentialInput {
    fn drop(&mut self) {
        self.password_mut().zeroize();
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudApiRelayResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CloudAccountState {
    PendingVerification,
    Active,
    Locked,
    Frozen,
    DeletionScheduled,
    Deleted,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloudAccountMetadata {
    schema_version: u8,
    account_id: String,
    state: CloudAccountState,
    revision: u64,
    verified_at: Option<String>,
    deletion_scheduled_for: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CloudDeviceState {
    Trusted,
    Revoked,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisteredDeviceMetadata {
    schema_version: u8,
    device_id: String,
    account_id: String,
    state: CloudDeviceState,
    public_key_fingerprint: String,
    created_at: String,
    revoked_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisteredDevicePublicKeyMetadata {
    schema_version: u8,
    device_id: String,
    account_id: String,
    algorithm: String,
    public_key: String,
    public_key_fingerprint: String,
    created_at: String,
    revoked_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloudDeviceMetadata {
    schema_version: u8,
    device: RegisteredDeviceMetadata,
    public_key: RegisteredDevicePublicKeyMetadata,
    display_name: String,
    revision: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloudSessionMetadata {
    schema_version: u8,
    session_id: String,
    account_id: String,
    device_id: String,
    client_version: String,
    minimum_client_version: String,
    issued_at: String,
    expires_at: String,
    revoked_at: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloudSessionTokenSet {
    access_token: String,
    access_token_expires_at: String,
    refresh_token: String,
    refresh_token_expires_at: String,
}

impl Drop for CloudSessionTokenSet {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloudSessionGrantResponse {
    schema_version: u8,
    request_id: String,
    account: CloudAccountMetadata,
    device: CloudDeviceMetadata,
    session: CloudSessionMetadata,
    tokens: CloudSessionTokenSet,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloudMutationAcceptedResponse {
    schema_version: u8,
    request_id: String,
    accepted: bool,
    completed_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloudApiErrorResponse {
    schema_version: u8,
    request_id: String,
    error: CloudApiErrorBody,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloudApiErrorBody {
    code: CloudApiErrorCode,
    message: String,
    retryable: bool,
    actions: Vec<CloudErrorAction>,
    support_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum CloudApiErrorCode {
    AuthInvalidCredentials,
    AuthEmailUnverified,
    AuthRateLimited,
    AuthAccountLocked,
    AuthAccountFrozen,
    AuthSessionExpired,
    AuthSessionRevoked,
    AuthRefreshReplayed,
    AuthDeviceRevoked,
    AuthUpgradeRequired,
    AuthNetworkUnavailable,
    AccessForbidden,
    ResourceNotFound,
    RevisionConflict,
    IdempotencyConflict,
    SyncCursorExpired,
    SyncSequenceConflict,
    SyncInvalidCiphertext,
    SyncQuotaExceeded,
    ValidationFailed,
    RateLimited,
    ServiceUnavailable,
    InternalError,
}

impl CloudApiErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::AuthInvalidCredentials => "AUTH_INVALID_CREDENTIALS",
            Self::AuthEmailUnverified => "AUTH_EMAIL_UNVERIFIED",
            Self::AuthRateLimited => "AUTH_RATE_LIMITED",
            Self::AuthAccountLocked => "AUTH_ACCOUNT_LOCKED",
            Self::AuthAccountFrozen => "AUTH_ACCOUNT_FROZEN",
            Self::AuthSessionExpired => "AUTH_SESSION_EXPIRED",
            Self::AuthSessionRevoked => "AUTH_SESSION_REVOKED",
            Self::AuthRefreshReplayed => "AUTH_REFRESH_REPLAYED",
            Self::AuthDeviceRevoked => "AUTH_DEVICE_REVOKED",
            Self::AuthUpgradeRequired => "AUTH_UPGRADE_REQUIRED",
            Self::AuthNetworkUnavailable => "AUTH_NETWORK_UNAVAILABLE",
            Self::AccessForbidden => "ACCESS_FORBIDDEN",
            Self::ResourceNotFound => "RESOURCE_NOT_FOUND",
            Self::RevisionConflict => "REVISION_CONFLICT",
            Self::IdempotencyConflict => "IDEMPOTENCY_CONFLICT",
            Self::SyncCursorExpired => "SYNC_CURSOR_EXPIRED",
            Self::SyncSequenceConflict => "SYNC_SEQUENCE_CONFLICT",
            Self::SyncInvalidCiphertext => "SYNC_INVALID_CIPHERTEXT",
            Self::SyncQuotaExceeded => "SYNC_QUOTA_EXCEEDED",
            Self::ValidationFailed => "VALIDATION_FAILED",
            Self::RateLimited => "RATE_LIMITED",
            Self::ServiceUnavailable => "SERVICE_UNAVAILABLE",
            Self::InternalError => "INTERNAL_ERROR",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum CloudErrorAction {
    Retry,
    Rename,
    UseLocal,
    ExportDraft,
    Restore,
    OpenSettings,
    SwitchModel,
    ReduceContext,
    ResolveConflict,
    RequestAccess,
    Reauthenticate,
    UpgradeClient,
    ContactSupport,
}

impl CloudErrorAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Retry => "RETRY",
            Self::Rename => "RENAME",
            Self::UseLocal => "USE_LOCAL",
            Self::ExportDraft => "EXPORT_DRAFT",
            Self::Restore => "RESTORE",
            Self::OpenSettings => "OPEN_SETTINGS",
            Self::SwitchModel => "SWITCH_MODEL",
            Self::ReduceContext => "REDUCE_CONTEXT",
            Self::ResolveConflict => "RESOLVE_CONFLICT",
            Self::RequestAccess => "REQUEST_ACCESS",
            Self::Reauthenticate => "REAUTHENTICATE",
            Self::UpgradeClient => "UPGRADE_CLIENT",
            Self::ContactSupport => "CONTACT_SUPPORT",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCloudSession {
    schema_version: u8,
    base_url: String,
    allow_insecure_loopback: bool,
    record_generation: u64,
    account: CloudAccountMetadata,
    device: CloudDeviceMetadata,
    session: CloudSessionMetadata,
    tokens: CloudSessionTokenSet,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct VaultVersion {
    session_id: String,
    record_generation: u64,
}

#[derive(Clone, Debug)]
struct ExpectedDeviceIdentity {
    device_id: String,
    display_name: String,
    algorithm: String,
    public_key: String,
    public_key_fingerprint: String,
    client_version: String,
}

#[derive(Clone, Debug)]
struct ValidatedCloudBaseUrl {
    url: Url,
    normalized: String,
    allow_insecure_loopback: bool,
}

#[derive(Clone, Copy)]
enum CloudRoute {
    VerifyEmail,
    Login,
    Refresh,
    Logout,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RelayQueryKind {
    None,
    Cursor,
    CursorWithLimit { maximum_limit: u16 },
    MarketplaceCatalog { maximum_limit: u16 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RelayRoutePolicy {
    authentication: CloudRelayAuthentication,
    requires_idempotency_key: bool,
    requires_body: bool,
    query: RelayQueryKind,
}

impl CloudRoute {
    fn path(self) -> &'static str {
        match self {
            Self::VerifyEmail => "/v1/identity/verifications",
            Self::Login => "/v1/auth/sessions",
            Self::Refresh => "/v1/auth/session-rotations",
            Self::Logout => "/v1/auth/session-revocations",
        }
    }

    fn expected_status(self) -> StatusCode {
        match self {
            Self::Logout => StatusCode::ACCEPTED,
            Self::VerifyEmail | Self::Login | Self::Refresh => StatusCode::OK,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudDeviceRegistrationBody<'a> {
    device_id: &'a str,
    display_name: &'a str,
    algorithm: &'a str,
    public_key: &'a str,
    public_key_fingerprint: &'a str,
    client_version: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudLoginBody<'a> {
    schema_version: u8,
    email: &'a str,
    password: &'a str,
    device: CloudDeviceRegistrationBody<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudEmailVerificationBody<'a> {
    schema_version: u8,
    challenge_id: &'a str,
    code: &'a str,
    device: CloudDeviceRegistrationBody<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudRefreshBody<'a> {
    schema_version: u8,
    device_id: &'a str,
    refresh_token: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudLogoutBody<'a> {
    schema_version: u8,
    session_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudDeletionSubmissionBody<'a> {
    schema_version: u8,
    expected_revision: u64,
    confirmation_id: &'a str,
    password: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAccountDeletionSubmissionBody<'a> {
    schema_version: u8,
    expected_revision: u64,
    confirmation_id: &'a str,
    email: &'a str,
    password: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAccountDeletionLookupBody<'a> {
    schema_version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    deletion_request_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confirmation_id: Option<&'a str>,
    email: &'a str,
    password: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAccountDeletionCancellationBody<'a> {
    schema_version: u8,
    deletion_request_id: &'a str,
    expected_deletion_revision: u64,
    email: &'a str,
    password: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudSessionExpirySummary {
    access_expires_at: String,
    refresh_expires_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudSessionVaultStatus {
    configured: bool,
    account: Option<CloudAccountMetadata>,
    device: Option<CloudDeviceMetadata>,
    session: Option<CloudSessionMetadata>,
    expiry: Option<CloudSessionExpirySummary>,
}

#[tauri::command]
pub(crate) async fn login_cloud_identity(
    input: CloudLoginInput,
    state: State<'_, CloudSessionVaultState>,
) -> Result<CloudSessionVaultStatus, CommandError> {
    let _mutation = state.mutation_guard.lock().await;
    let endpoint = ValidatedCloudBaseUrl::parse(&input.endpoint)?;
    let email = normalize_email(&input.email)?;
    validate_password(&input.password)?;
    let expected_device = load_expected_device(&input.device)?;
    let expected_version = {
        let _guard = lock_vault(&state)?;
        let current = read_stored_session()?;
        if current.is_some() {
            return Err(session_already_configured());
        }
        None
    };
    let body = CloudLoginBody {
        schema_version: CLOUD_SCHEMA_VERSION,
        email: &email,
        password: &input.password,
        device: device_body(&expected_device),
    };
    let request_id = Uuid::now_v7().to_string();
    let grant: CloudSessionGrantResponse =
        send_cloud_json(&endpoint, CloudRoute::Login, &request_id, &body, None).await?;
    validate_session_grant(&grant, &request_id, &expected_device, None)?;
    commit_session_grant(&state, expected_version.as_ref(), &endpoint, grant)
}

#[tauri::command]
pub(crate) async fn verify_cloud_identity_email(
    input: CloudEmailVerificationInput,
    state: State<'_, CloudSessionVaultState>,
) -> Result<CloudSessionVaultStatus, CommandError> {
    let _mutation = state.mutation_guard.lock().await;
    let endpoint = ValidatedCloudBaseUrl::parse(&input.endpoint)?;
    validate_uuid_v7(&input.challenge_id)?;
    validate_one_time_code(&input.code)?;
    let expected_device = load_expected_device(&input.device)?;
    let expected_version = {
        let _guard = lock_vault(&state)?;
        let current = read_stored_session()?;
        if current.is_some() {
            return Err(session_already_configured());
        }
        None
    };
    let body = CloudEmailVerificationBody {
        schema_version: CLOUD_SCHEMA_VERSION,
        challenge_id: &input.challenge_id,
        code: &input.code,
        device: device_body(&expected_device),
    };
    let request_id = Uuid::now_v7().to_string();
    let grant: CloudSessionGrantResponse =
        send_cloud_json(&endpoint, CloudRoute::VerifyEmail, &request_id, &body, None).await?;
    validate_session_grant(&grant, &request_id, &expected_device, None)?;
    commit_session_grant(&state, expected_version.as_ref(), &endpoint, grant)
}

#[tauri::command]
pub(crate) async fn refresh_cloud_session(
    input: CloudSessionMutationInput,
    state: State<'_, CloudSessionVaultState>,
) -> Result<CloudSessionVaultStatus, CommandError> {
    let _mutation = state.mutation_guard.lock().await;
    validate_uuid_v7(&input.expected_session_id)?;
    let (stored, expected_version) = {
        let _guard = lock_vault(&state)?;
        let stored = read_stored_session()?.ok_or_else(session_not_configured)?;
        let version = vault_version(&stored);
        require_expected_session(&version, &input.expected_session_id)?;
        (stored, version)
    };
    let endpoint =
        ValidatedCloudBaseUrl::parse_stored(&stored.base_url, stored.allow_insecure_loopback)?;
    let expected_device = expected_device_from_stored(&stored)?;
    validate_local_device_binding(&expected_device)?;
    let body = CloudRefreshBody {
        schema_version: CLOUD_SCHEMA_VERSION,
        device_id: &stored.device.device.device_id,
        refresh_token: &stored.tokens.refresh_token,
    };
    let request_id = Uuid::now_v7().to_string();
    let grant: CloudSessionGrantResponse =
        send_cloud_json(&endpoint, CloudRoute::Refresh, &request_id, &body, None).await?;
    validate_session_grant(
        &grant,
        &request_id,
        &expected_device,
        Some(&stored.account.account_id),
    )?;
    commit_session_grant(&state, Some(&expected_version), &endpoint, grant)
}

#[tauri::command]
pub(crate) fn get_cloud_session_status(
    state: State<'_, CloudSessionVaultState>,
) -> Result<CloudSessionVaultStatus, CommandError> {
    let _guard = lock_vault(&state)?;
    match read_stored_session()? {
        Some(record) => Ok(status_from_record(&record)),
        None => Ok(empty_status()),
    }
}

#[tauri::command]
pub(crate) async fn send_cloud_api_request(
    input: SendCloudApiRequestInput,
    state: State<'_, CloudSessionVaultState>,
) -> Result<CloudApiRelayResponse, CommandError> {
    let endpoint = ValidatedCloudBaseUrl::parse(&CloudEndpointInput {
        base_url: input.base_url.clone(),
        allow_insecure_loopback: input.allow_insecure_loopback,
    })?;
    let policy = validate_relay_route(input.method, &input.path)?;
    if policy.authentication != input.authentication {
        return Err(cloud_relay_request_invalid());
    }
    let headers = validate_relay_headers(&input.headers, policy.requires_idempotency_key)?;
    validate_relay_body(&input.body, policy.requires_body)?;

    let stored = if input.authentication == CloudRelayAuthentication::Session {
        let _guard = lock_vault(&state)?;
        let stored = read_stored_session()?.ok_or_else(session_not_configured)?;
        if stored.base_url != endpoint.normalized
            || stored.allow_insecure_loopback != endpoint.allow_insecure_loopback
        {
            return Err(cloud_endpoint_session_mismatch());
        }
        let expected_device = expected_device_from_stored(&stored)?;
        validate_local_device_binding(&expected_device)?;
        Some(stored)
    } else {
        None
    };

    send_cloud_relay_http(
        &endpoint,
        input.method,
        &input.path,
        &headers,
        &input.body,
        stored.as_ref(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn accept_current_device_team_project_key_envelope_from_cloud(
    input: AcceptCurrentDeviceTeamProjectKeyEnvelopeInput,
    session_state: State<'_, CloudSessionVaultState>,
    project_key_state: State<'_, ProjectKeyVaultState>,
) -> Result<TeamProjectKeyReceiptCommit, CommandError> {
    let _mutation = session_state.mutation_guard.lock().await;
    validate_uuid_v7(&input.team_id)?;
    validate_uuid_v7(&input.project_id)?;
    validate_uuid_v7(&input.expected_session_id)?;
    validate_uuid_v7(&input.expected_account_id)?;
    validate_uuid_v7(&input.expected_device_id)?;
    validate_device_public_key(
        &input.expected_recipient_public_key,
        &input.expected_recipient_public_key_fingerprint,
    )?;

    let (stored, expected_version, expected_device) = {
        let _guard = lock_vault(&session_state)?;
        let stored = read_stored_session()?.ok_or_else(session_not_configured)?;
        let version = vault_version(&stored);
        require_expected_session(&version, &input.expected_session_id)?;
        let expected_device = expected_device_from_stored(&stored)?;
        if stored.account.account_id != input.expected_account_id
            || expected_device.device_id != input.expected_device_id
            || expected_device.public_key != input.expected_recipient_public_key
            || expected_device.public_key_fingerprint
                != input.expected_recipient_public_key_fingerprint
        {
            return Err(device_identity_mismatch());
        }
        validate_local_device_binding(&expected_device)?;
        (stored, version, expected_device)
    };

    let endpoint =
        ValidatedCloudBaseUrl::parse_stored(&stored.base_url, stored.allow_insecure_loopback)?;
    let current_key_path = format!(
        "/v1/teams/{}/projects/{}/keys/current",
        input.team_id, input.project_id
    );
    let current_key_request_id = Uuid::now_v7().to_string();
    let current_key = fetch_current_team_project_key_metadata(
        &endpoint,
        &current_key_path,
        &current_key_request_id,
        &stored,
    )
    .await?;
    validate_current_team_project_key_metadata(
        &current_key,
        &current_key_request_id,
        &input.team_id,
        &input.project_id,
    )?;
    if !current_key.current_device_envelope_available {
        return Err(current_device_team_project_key_envelope_unavailable(
            &current_key_request_id,
        ));
    }

    let envelope_request_id = Uuid::now_v7().to_string();
    let envelope_path = format!(
        "/v1/teams/{}/projects/{}/keys/{}/envelopes/current-device",
        input.team_id, input.project_id, current_key.key_version
    );
    let response = fetch_current_device_team_project_key_envelope(
        &endpoint,
        &envelope_path,
        &envelope_request_id,
        &stored,
    )
    .await?;
    if response.schema_version != CLOUD_SCHEMA_VERSION || response.request_id != envelope_request_id
    {
        return Err(cloud_protocol_invalid(&envelope_request_id));
    }
    validate_uuid_v7(&response.request_id)
        .map_err(|_| cloud_protocol_invalid(&envelope_request_id))?;
    let created_at = response
        .envelope
        .created_at()
        .ok_or_else(|| cloud_protocol_invalid(&envelope_request_id))?;
    parse_iso_utc_timestamp(created_at)
        .map_err(|_| cloud_protocol_invalid(&envelope_request_id))?;

    let confirmation_request_id = Uuid::now_v7().to_string();
    let confirmed_current_key = fetch_current_team_project_key_metadata(
        &endpoint,
        &current_key_path,
        &confirmation_request_id,
        &stored,
    )
    .await?;
    validate_current_team_project_key_metadata(
        &confirmed_current_key,
        &confirmation_request_id,
        &input.team_id,
        &input.project_id,
    )?;
    ensure_current_team_project_key_metadata_unchanged(
        &current_key,
        &confirmed_current_key,
        &confirmation_request_id,
    )?;

    {
        let _guard = lock_vault(&session_state)?;
        let current = read_stored_session()?.ok_or_else(session_not_configured)?;
        ensure_compare_and_swap(Some(vault_version(&current)), Some(&expected_version))?;
        let current_device = expected_device_from_stored(&current)?;
        if current.account.account_id != input.expected_account_id
            || current_device.device_id != expected_device.device_id
            || current_device.public_key != expected_device.public_key
            || current_device.public_key_fingerprint != expected_device.public_key_fingerprint
        {
            return Err(device_identity_mismatch());
        }
        validate_local_device_binding(&current_device)?;
    }

    accept_current_device_team_project_key_envelope(
        project_key_state.inner(),
        response.envelope,
        TeamProjectKeyEnvelopeExpectation {
            account_id: &input.expected_account_id,
            team_id: &input.team_id,
            project_id: &input.project_id,
            key_version: current_key.key_version,
            current_key_server_revision: current_key.server_revision,
            current_key_updated_at: &current_key.updated_at,
            recipient_device_id: &expected_device.device_id,
            recipient_public_key: &expected_device.public_key,
            recipient_public_key_fingerprint: &expected_device.public_key_fingerprint,
        },
    )
}

#[tauri::command]
pub(crate) fn inspect_stored_team_project_key_receipt(
    input: TeamProjectKeyReceiptAccessInput,
    session_state: State<'_, CloudSessionVaultState>,
    project_key_state: State<'_, ProjectKeyVaultState>,
) -> Result<TeamProjectKeyReceiptStatus, CommandError> {
    validate_team_project_key_receipt_session_binding(&input, session_state.inner(), true)?;
    inspect_team_project_key_receipt(project_key_state.inner(), &input.receipt)
}

#[tauri::command]
pub(crate) fn open_stored_team_project_key_receipt(
    input: TeamProjectKeyReceiptAccessInput,
    session_state: State<'_, CloudSessionVaultState>,
    project_key_state: State<'_, ProjectKeyVaultState>,
) -> Result<ProjectDataKeyMaterial, CommandError> {
    validate_team_project_key_receipt_session_binding(&input, session_state.inner(), true)?;
    open_team_project_key_receipt(project_key_state.inner(), &input.receipt)
}

#[tauri::command]
pub(crate) fn remove_stored_team_project_key_receipt(
    input: TeamProjectKeyReceiptAccessInput,
    session_state: State<'_, CloudSessionVaultState>,
    project_key_state: State<'_, ProjectKeyVaultState>,
) -> Result<TeamProjectKeyReceiptRemoval, CommandError> {
    validate_team_project_key_receipt_session_binding(&input, session_state.inner(), false)?;
    remove_team_project_key_receipt_if_current(project_key_state.inner(), &input.receipt)
}

#[tauri::command]
pub(crate) async fn send_cloud_deletion_credential_request(
    input: CloudDeletionCredentialInput,
    state: State<'_, CloudSessionVaultState>,
) -> Result<CloudApiRelayResponse, CommandError> {
    let _mutation = state.mutation_guard.lock().await;
    let endpoint = ValidatedCloudBaseUrl::parse(&input.endpoint())?;

    match &input {
        CloudDeletionCredentialInput::RequestProject {
            project_id,
            request_id,
            idempotency_key,
            expected_revision,
            confirmation_id,
            password,
            ..
        } => {
            validate_uuid_v7(project_id)?;
            validate_deletion_credential_common(
                request_id,
                Some(idempotency_key),
                *expected_revision,
                password,
            )?;
            validate_uuid_v7(confirmation_id)?;
            let body = CloudDeletionSubmissionBody {
                schema_version: CLOUD_SCHEMA_VERSION,
                expected_revision: *expected_revision,
                confirmation_id,
                password,
            };
            let stored = load_bound_cloud_session(&state, &endpoint)?;
            send_cloud_deletion_json(
                &endpoint,
                &format!("/v1/projects/{project_id}/deletion-requests"),
                request_id,
                Some(idempotency_key),
                &body,
                Some(&stored),
                password,
            )
            .await
        }
        CloudDeletionCredentialInput::RequestAccount {
            request_id,
            idempotency_key,
            expected_revision,
            confirmation_id,
            email,
            password,
            ..
        } => {
            validate_deletion_credential_common(
                request_id,
                Some(idempotency_key),
                *expected_revision,
                password,
            )?;
            validate_uuid_v7(confirmation_id)?;
            let normalized_email = normalize_email(email)?;
            let body = CloudAccountDeletionSubmissionBody {
                schema_version: CLOUD_SCHEMA_VERSION,
                expected_revision: *expected_revision,
                confirmation_id,
                email: &normalized_email,
                password,
            };
            let stored = load_bound_cloud_session(&state, &endpoint)?;
            send_cloud_deletion_json(
                &endpoint,
                "/v1/account/deletion-requests",
                request_id,
                Some(idempotency_key),
                &body,
                Some(&stored),
                password,
            )
            .await
        }
        CloudDeletionCredentialInput::LookupAccount {
            request_id,
            deletion_request_id,
            confirmation_id,
            email,
            password,
            ..
        } => {
            validate_uuid_v7(request_id)?;
            let (deletion_request_id, confirmation_id) = validate_deletion_lookup_proof(
                deletion_request_id.as_deref(),
                confirmation_id.as_deref(),
            )?;
            validate_password(password)?;
            let normalized_email = normalize_email(email)?;
            let body = CloudAccountDeletionLookupBody {
                schema_version: CLOUD_SCHEMA_VERSION,
                deletion_request_id,
                confirmation_id,
                email: &normalized_email,
                password,
            };
            send_cloud_deletion_json(
                &endpoint,
                "/v1/account/deletion-request-lookups",
                request_id,
                None,
                &body,
                None,
                password,
            )
            .await
        }
        CloudDeletionCredentialInput::CancelAccount {
            request_id,
            idempotency_key,
            deletion_request_id,
            expected_deletion_revision,
            email,
            password,
            ..
        } => {
            validate_deletion_credential_common(
                request_id,
                Some(idempotency_key),
                *expected_deletion_revision,
                password,
            )?;
            validate_uuid_v7(deletion_request_id)?;
            let normalized_email = normalize_email(email)?;
            let body = CloudAccountDeletionCancellationBody {
                schema_version: CLOUD_SCHEMA_VERSION,
                deletion_request_id,
                expected_deletion_revision: *expected_deletion_revision,
                email: &normalized_email,
                password,
            };
            send_cloud_deletion_json(
                &endpoint,
                "/v1/account/deletion-cancellations",
                request_id,
                Some(idempotency_key),
                &body,
                None,
                password,
            )
            .await
        }
    }
}

fn load_bound_cloud_session(
    state: &CloudSessionVaultState,
    endpoint: &ValidatedCloudBaseUrl,
) -> Result<StoredCloudSession, CommandError> {
    let _guard = lock_vault(state)?;
    let stored = read_stored_session()?.ok_or_else(session_not_configured)?;
    if stored.base_url != endpoint.normalized
        || stored.allow_insecure_loopback != endpoint.allow_insecure_loopback
    {
        return Err(cloud_endpoint_session_mismatch());
    }
    let expected_device = expected_device_from_stored(&stored)?;
    validate_local_device_binding(&expected_device)?;
    Ok(stored)
}

#[tauri::command]
pub(crate) async fn logout_cloud_session(
    input: CloudSessionMutationInput,
    state: State<'_, CloudSessionVaultState>,
) -> Result<CloudSessionVaultStatus, CommandError> {
    let _mutation = state.mutation_guard.lock().await;
    validate_uuid_v7(&input.expected_session_id)?;
    let (stored, expected_version) = {
        let _guard = lock_vault(&state)?;
        let stored = read_stored_session()?.ok_or_else(session_not_configured)?;
        let version = vault_version(&stored);
        require_expected_session(&version, &input.expected_session_id)?;
        (stored, version)
    };
    let endpoint =
        ValidatedCloudBaseUrl::parse_stored(&stored.base_url, stored.allow_insecure_loopback)?;
    let expected_device = expected_device_from_stored(&stored)?;
    validate_local_device_binding(&expected_device)?;
    let body = CloudLogoutBody {
        schema_version: CLOUD_SCHEMA_VERSION,
        session_id: &stored.session.session_id,
    };
    let request_id = Uuid::now_v7().to_string();
    let response: CloudMutationAcceptedResponse = send_cloud_json(
        &endpoint,
        CloudRoute::Logout,
        &request_id,
        &body,
        Some(&stored.tokens.access_token),
    )
    .await?;
    validate_accepted_response(&response, &request_id)?;
    clear_if_current(&state, &expected_version)
}

#[tauri::command]
pub(crate) fn clear_cloud_session(
    expected_session_id: Option<String>,
    state: State<'_, CloudSessionVaultState>,
) -> Result<CloudSessionVaultStatus, CommandError> {
    if let Some(expected) = expected_session_id.as_deref() {
        validate_uuid_v7(expected)?;
    }
    let _guard = lock_vault(&state)?;
    let entry = cloud_session_entry()?;
    let stored = match entry.get_password() {
        Ok(value) => Zeroizing::new(value),
        Err(keyring::Error::NoEntry) => return Ok(empty_status()),
        Err(_) => return Err(CommandError::credential_store_unavailable()),
    };
    match decode_stored_session(stored.as_str()) {
        Ok(record) => {
            let Some(expected) = expected_session_id.as_deref() else {
                return Err(stale_session_error());
            };
            require_expected_session(&vault_version(&record), expected)?;
        }
        Err(error) => {
            if expected_session_id.is_some() {
                return Err(error);
            }
        }
    }
    delete_cloud_session_entry(&entry)
}

fn load_expected_device(input: &CloudDeviceInput) -> Result<ExpectedDeviceIdentity, CommandError> {
    validate_display_name(&input.display_name)?;
    let summary = load_device_identity_summary(&input.device_id)?;
    Ok(expected_device_from_summary(&summary, &input.display_name))
}

fn expected_device_from_summary(
    summary: &DeviceIdentitySummary,
    display_name: &str,
) -> ExpectedDeviceIdentity {
    ExpectedDeviceIdentity {
        device_id: summary.device_id.clone(),
        display_name: display_name.to_owned(),
        algorithm: summary.algorithm.to_owned(),
        public_key: summary.public_key.clone(),
        public_key_fingerprint: summary.public_key_fingerprint.clone(),
        client_version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

fn expected_device_from_stored(
    stored: &StoredCloudSession,
) -> Result<ExpectedDeviceIdentity, CommandError> {
    let expected = ExpectedDeviceIdentity {
        device_id: stored.device.device.device_id.clone(),
        display_name: stored.device.display_name.clone(),
        algorithm: stored.device.public_key.algorithm.clone(),
        public_key: stored.device.public_key.public_key.clone(),
        public_key_fingerprint: stored.device.public_key.public_key_fingerprint.clone(),
        client_version: stored.session.client_version.clone(),
    };
    validate_expected_device(&expected)?;
    Ok(expected)
}

fn validate_local_device_binding(expected: &ExpectedDeviceIdentity) -> Result<(), CommandError> {
    let local = load_device_identity_summary(&expected.device_id)?;
    if local.schema_version != CLOUD_SCHEMA_VERSION
        || local.algorithm != expected.algorithm
        || local.public_key != expected.public_key
        || local.public_key_fingerprint != expected.public_key_fingerprint
    {
        return Err(device_identity_mismatch());
    }
    Ok(())
}

fn validate_team_project_key_receipt_session_binding(
    input: &TeamProjectKeyReceiptAccessInput,
    state: &CloudSessionVaultState,
    allow_signed_out: bool,
) -> Result<(), CommandError> {
    let stored = {
        let _guard = lock_vault(state)?;
        read_stored_session()?
    };
    match resolve_team_project_key_receipt_local_authority(
        stored.as_ref(),
        input,
        allow_signed_out,
    )? {
        Some(expected_device) => validate_local_device_binding(&expected_device),
        None => {
            let local = load_device_identity_summary(&input.receipt.device_id)?;
            if local.public_key_fingerprint != input.receipt.recipient_public_key_fingerprint {
                return Err(device_identity_mismatch());
            }
            Ok(())
        }
    }
}

fn resolve_team_project_key_receipt_local_authority(
    stored: Option<&StoredCloudSession>,
    input: &TeamProjectKeyReceiptAccessInput,
    allow_signed_out: bool,
) -> Result<Option<ExpectedDeviceIdentity>, CommandError> {
    if let Some(expected_session_id) = input.expected_session_id.as_deref() {
        validate_uuid_v7(expected_session_id)?;
    }
    let Some(stored) = stored else {
        return if allow_signed_out && input.expected_session_id.is_none() {
            Ok(None)
        } else {
            Err(stale_session_error())
        };
    };
    let expected_session_id = input
        .expected_session_id
        .as_deref()
        .ok_or_else(stale_session_error)?;
    require_expected_session(&vault_version(stored), expected_session_id)?;
    let expected_device = expected_device_from_stored(stored)?;
    if stored.account.account_id != input.receipt.account_id
        || expected_device.device_id != input.receipt.device_id
        || expected_device.public_key_fingerprint != input.receipt.recipient_public_key_fingerprint
    {
        return Err(device_identity_mismatch());
    }
    Ok(Some(expected_device))
}

fn device_body(expected: &ExpectedDeviceIdentity) -> CloudDeviceRegistrationBody<'_> {
    CloudDeviceRegistrationBody {
        device_id: &expected.device_id,
        display_name: &expected.display_name,
        algorithm: &expected.algorithm,
        public_key: &expected.public_key,
        public_key_fingerprint: &expected.public_key_fingerprint,
        client_version: &expected.client_version,
    }
}

fn commit_session_grant(
    state: &CloudSessionVaultState,
    expected: Option<&VaultVersion>,
    endpoint: &ValidatedCloudBaseUrl,
    grant: CloudSessionGrantResponse,
) -> Result<CloudSessionVaultStatus, CommandError> {
    let _guard = lock_vault(state)?;
    let current = read_stored_session()?;
    ensure_compare_and_swap(current.as_ref().map(vault_version), expected)?;
    let generation = expected
        .map(|version| version.record_generation)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(session_vault_corrupted)?;
    let record = stored_session_from_grant(grant, endpoint, generation);
    validate_stored_session(&record)?;
    let encoded = encode_stored_session(&record)?;
    cloud_session_entry()?
        .set_password(encoded.as_str())
        .map_err(|_| CommandError::credential_store_unavailable())?;
    Ok(status_from_record(&record))
}

fn clear_if_current(
    state: &CloudSessionVaultState,
    expected: &VaultVersion,
) -> Result<CloudSessionVaultStatus, CommandError> {
    let _guard = lock_vault(state)?;
    let current = read_stored_session()?;
    ensure_compare_and_swap(current.as_ref().map(vault_version), Some(expected))?;
    delete_cloud_session_entry(&cloud_session_entry()?)
}

fn delete_cloud_session_entry(
    entry: &keyring::Entry,
) -> Result<CloudSessionVaultStatus, CommandError> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(empty_status()),
        Err(_) => Err(CommandError::credential_store_unavailable()),
    }
}

fn stored_session_from_grant(
    grant: CloudSessionGrantResponse,
    endpoint: &ValidatedCloudBaseUrl,
    record_generation: u64,
) -> StoredCloudSession {
    StoredCloudSession {
        schema_version: STORED_SCHEMA_VERSION,
        base_url: endpoint.normalized.clone(),
        allow_insecure_loopback: endpoint.allow_insecure_loopback,
        record_generation,
        account: grant.account,
        device: grant.device,
        session: grant.session,
        tokens: grant.tokens,
    }
}

fn vault_version(record: &StoredCloudSession) -> VaultVersion {
    VaultVersion {
        session_id: record.session.session_id.clone(),
        record_generation: record.record_generation,
    }
}

fn ensure_compare_and_swap(
    current: Option<VaultVersion>,
    expected: Option<&VaultVersion>,
) -> Result<(), CommandError> {
    if current.as_ref() == expected {
        Ok(())
    } else {
        Err(stale_session_error())
    }
}

fn require_expected_session(
    current: &VaultVersion,
    expected_session_id: &str,
) -> Result<(), CommandError> {
    if current.session_id == expected_session_id {
        Ok(())
    } else {
        Err(stale_session_error())
    }
}

fn encode_stored_session(record: &StoredCloudSession) -> Result<Zeroizing<String>, CommandError> {
    let json =
        Zeroizing::new(serde_json::to_string(record).map_err(|_| session_vault_corrupted())?);
    let mut encoded = Zeroizing::new(String::with_capacity(
        STORED_SESSION_PREFIX.len() + json.len(),
    ));
    encoded.push_str(STORED_SESSION_PREFIX);
    encoded.push_str(json.as_str());
    Ok(encoded)
}

fn decode_stored_session(value: &str) -> Result<StoredCloudSession, CommandError> {
    let json = value
        .strip_prefix(STORED_SESSION_PREFIX)
        .ok_or_else(session_vault_corrupted)?;
    if json.is_empty() || json.len() > MAX_STORED_SESSION_BYTES {
        return Err(session_vault_corrupted());
    }
    let record: StoredCloudSession =
        serde_json::from_str(json).map_err(|_| session_vault_corrupted())?;
    validate_stored_session(&record)?;
    Ok(record)
}

fn validate_stored_session(record: &StoredCloudSession) -> Result<(), CommandError> {
    if record.schema_version != STORED_SCHEMA_VERSION || record.record_generation == 0 {
        return Err(session_vault_corrupted());
    }
    let endpoint =
        ValidatedCloudBaseUrl::parse_stored(&record.base_url, record.allow_insecure_loopback)
            .map_err(|_| session_vault_corrupted())?;
    if endpoint.normalized != record.base_url {
        return Err(session_vault_corrupted());
    }
    let expected = expected_device_from_stored(record).map_err(|_| session_vault_corrupted())?;
    validate_session_material(
        &record.account,
        &record.device,
        &record.session,
        &record.tokens,
        &expected,
        Some(&record.account.account_id),
    )
    .map_err(|_| session_vault_corrupted())
}

fn read_stored_session() -> Result<Option<StoredCloudSession>, CommandError> {
    match cloud_session_entry()?.get_password() {
        Ok(value) => {
            let value = Zeroizing::new(value);
            decode_stored_session(value.as_str()).map(Some)
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(CommandError::credential_store_unavailable()),
    }
}

fn cloud_session_entry() -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(credential_service(), CLOUD_SESSION_ACCOUNT)
        .map_err(|_| CommandError::credential_store_unavailable())
}

fn lock_vault(state: &CloudSessionVaultState) -> Result<MutexGuard<'_, ()>, CommandError> {
    state.vault_guard.lock().map_err(|_| {
        CommandError::new(
            "CLOUD_SESSION_VAULT_UNAVAILABLE",
            "The cloud session vault is temporarily unavailable.",
            true,
            vec!["RETRY", "OPEN_DIAGNOSTICS"],
        )
    })
}

fn status_from_record(record: &StoredCloudSession) -> CloudSessionVaultStatus {
    CloudSessionVaultStatus {
        configured: true,
        account: Some(record.account.clone()),
        device: Some(record.device.clone()),
        session: Some(record.session.clone()),
        expiry: Some(CloudSessionExpirySummary {
            access_expires_at: record.tokens.access_token_expires_at.clone(),
            refresh_expires_at: record.tokens.refresh_token_expires_at.clone(),
        }),
    }
}

fn empty_status() -> CloudSessionVaultStatus {
    CloudSessionVaultStatus {
        configured: false,
        account: None,
        device: None,
        session: None,
        expiry: None,
    }
}

impl ValidatedCloudBaseUrl {
    fn parse(input: &CloudEndpointInput) -> Result<Self, CommandError> {
        Self::parse_inner(&input.base_url, input.allow_insecure_loopback)
    }

    fn parse_stored(base_url: &str, allow_insecure_loopback: bool) -> Result<Self, CommandError> {
        Self::parse_inner(base_url, allow_insecure_loopback)
    }

    fn parse_inner(input: &str, allow_insecure_loopback: bool) -> Result<Self, CommandError> {
        if input.is_empty()
            || input.len() > MAX_BASE_URL_BYTES
            || input.trim() != input
            || input.contains('%')
            || input.contains('\\')
            || input.bytes().any(|byte| byte.is_ascii_control())
            || has_dot_path_segment(input)
        {
            return Err(cloud_endpoint_invalid());
        }
        let mut url = Url::parse(input).map_err(|_| cloud_endpoint_invalid())?;
        if url.cannot_be_a_base()
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.port() == Some(0)
        {
            return Err(cloud_endpoint_invalid());
        }
        let host = url.host_str().unwrap_or_default();
        if host_is_ip_literal(host) && !literal_ip_is_allowed(host) {
            return Err(cloud_endpoint_invalid());
        }
        let loopback = host_is_explicit_loopback(host);
        match url.scheme() {
            "https" if !allow_insecure_loopback => {}
            "https" => return Err(cloud_endpoint_invalid()),
            "http" if cfg!(debug_assertions) && allow_insecure_loopback && loopback => {}
            _ => return Err(cloud_endpoint_invalid()),
        }
        let normalized_path = url.path().trim_end_matches('/').to_owned();
        url.set_path(if normalized_path.is_empty() {
            "/"
        } else {
            &normalized_path
        });
        let mut normalized = url.to_string();
        if url.path() == "/" {
            normalized.truncate(normalized.len().saturating_sub(1));
        }
        Ok(Self {
            url,
            normalized,
            allow_insecure_loopback,
        })
    }

    fn api_url(&self, route: CloudRoute) -> Url {
        let mut url = self.url.clone();
        let base_path = self.url.path().trim_end_matches('/');
        url.set_path(&format!("{base_path}{}", route.path()));
        url.set_query(None);
        url.set_fragment(None);
        url
    }

    fn relay_url(&self, relative: &Url) -> Url {
        let mut url = self.url.clone();
        let base_path = self.url.path().trim_end_matches('/');
        url.set_path(&format!("{base_path}{}", relative.path()));
        url.set_query(relative.query());
        url.set_fragment(None);
        url
    }
}

fn has_dot_path_segment(input: &str) -> bool {
    let without_scheme = input
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(input);
    let path = without_scheme
        .find('/')
        .map(|index| &without_scheme[index..])
        .unwrap_or("");
    path.split('/')
        .any(|segment| segment == "." || segment == "..")
}

fn validate_relay_route(
    method: CloudRelayMethod,
    input: &str,
) -> Result<RelayRoutePolicy, CommandError> {
    if input.is_empty()
        || input.len() > 4_096
        || !input.starts_with('/')
        || input.starts_with("//")
        || input.contains('\\')
        || input.contains('#')
        || input.contains('%')
        || !input.is_ascii()
        || input.bytes().any(|byte| byte.is_ascii_control())
        || has_dot_path_segment(input)
    {
        return Err(cloud_relay_request_invalid());
    }
    let parsed = Url::parse(&format!("https://inkshadow.invalid{input}"))
        .map_err(|_| cloud_relay_request_invalid())?;
    if parsed.origin().ascii_serialization() != "https://inkshadow.invalid" {
        return Err(cloud_relay_request_invalid());
    }
    let path = parsed.path();
    let segments = path.split('/').collect::<Vec<_>>();
    let policy = match (method, path) {
        (CloudRelayMethod::Post, "/v1/identity/registrations")
        | (CloudRelayMethod::Post, "/v1/identity/password-resets")
        | (CloudRelayMethod::Post, "/v1/identity/password-resets/confirmations") => {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::None,
                requires_idempotency_key: true,
                requires_body: true,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Get, "/v1/auth/sessions") | (CloudRelayMethod::Get, "/v1/devices") => {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: false,
                requires_body: false,
                query: RelayQueryKind::CursorWithLimit {
                    maximum_limit: 1_024,
                },
            }
        }
        (CloudRelayMethod::Post, "/v1/devices") => RelayRoutePolicy {
            authentication: CloudRelayAuthentication::Session,
            requires_idempotency_key: true,
            requires_body: true,
            query: RelayQueryKind::None,
        },
        (CloudRelayMethod::Post, "/v1/teams") => RelayRoutePolicy {
            authentication: CloudRelayAuthentication::Session,
            requires_idempotency_key: true,
            requires_body: true,
            query: RelayQueryKind::None,
        },
        (CloudRelayMethod::Get, "/v1/teams") => RelayRoutePolicy {
            authentication: CloudRelayAuthentication::Session,
            requires_idempotency_key: false,
            requires_body: false,
            query: RelayQueryKind::CursorWithLimit {
                maximum_limit: 1_024,
            },
        },
        (CloudRelayMethod::Get, "/v1/marketplace/artifacts") => RelayRoutePolicy {
            authentication: CloudRelayAuthentication::Session,
            requires_idempotency_key: false,
            requires_body: false,
            query: RelayQueryKind::MarketplaceCatalog { maximum_limit: 100 },
        },
        (CloudRelayMethod::Post, "/v1/marketplace/artifacts/submissions") => RelayRoutePolicy {
            authentication: CloudRelayAuthentication::Session,
            requires_idempotency_key: true,
            requires_body: true,
            query: RelayQueryKind::None,
        },
        (CloudRelayMethod::Post, _) if is_marketplace_artifact_download_route(&segments) => {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: true,
                requires_body: true,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Post, _)
            if ["reports", "withdrawals", "appeals"]
                .iter()
                .any(|operation| is_marketplace_version_mutation_route(&segments, operation)) =>
        {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: true,
                requires_body: true,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Get, _) if is_team_member_list_route(&segments) => RelayRoutePolicy {
            authentication: CloudRelayAuthentication::Session,
            requires_idempotency_key: false,
            requires_body: false,
            query: RelayQueryKind::CursorWithLimit {
                maximum_limit: 1_024,
            },
        },
        (CloudRelayMethod::Post, _)
            if is_team_invitation_create_route(&segments)
                || is_team_invitation_accept_route(&segments)
                || is_team_member_mutation_route(&segments, "role-changes")
                || is_team_member_mutation_route(&segments, "revocations") =>
        {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: true,
                requires_body: true,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Get, _) if is_project_assignment_list_route(&segments) => {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: false,
                requires_body: false,
                query: RelayQueryKind::CursorWithLimit {
                    maximum_limit: 1_024,
                },
            }
        }
        (CloudRelayMethod::Put, _) if is_project_assignment_set_route(&segments) => {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: true,
                requires_body: true,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Get, _) if is_current_team_project_key_route(&segments) => {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: false,
                requires_body: false,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Get, _) if is_team_project_key_recipient_list_route(&segments) => {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: false,
                requires_body: false,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Post, _) if is_team_project_key_envelope_publish_route(&segments) => {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: true,
                requires_body: true,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Delete, _)
            if segments.len() == 5
                && segments[1] == "v1"
                && segments[2] == "auth"
                && segments[3] == "sessions"
                && validate_uuid_v7(segments[4]).is_ok() =>
        {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: true,
                requires_body: false,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Delete, _)
            if segments.len() == 4
                && segments[1] == "v1"
                && segments[2] == "devices"
                && validate_uuid_v7(segments[3]).is_ok() =>
        {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: true,
                requires_body: false,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Get, _) if is_current_project_key_route(&segments) => RelayRoutePolicy {
            authentication: CloudRelayAuthentication::Session,
            requires_idempotency_key: false,
            requires_body: false,
            query: RelayQueryKind::None,
        },
        (CloudRelayMethod::Get | CloudRelayMethod::Put, _)
            if is_versioned_project_key_route(&segments) =>
        {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: method == CloudRelayMethod::Put,
                requires_body: method == CloudRelayMethod::Put,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Get, _) if is_project_state_route(&segments) => RelayRoutePolicy {
            authentication: CloudRelayAuthentication::Session,
            requires_idempotency_key: false,
            requires_body: false,
            query: RelayQueryKind::Cursor,
        },
        (CloudRelayMethod::Get, _) if is_project_deletion_lookup_route(&segments) => {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: false,
                requires_body: false,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Post, _) if is_project_deletion_cancellation_route(&segments) => {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: true,
                requires_body: true,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Post, _)
            if is_project_sync_route(&segments, "push")
                || is_project_sync_route(&segments, "tombstone-acknowledgements") =>
        {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: true,
                requires_body: true,
                query: RelayQueryKind::None,
            }
        }
        (CloudRelayMethod::Get, _)
            if is_project_sync_route(&segments, "pull")
                || is_project_sync_route(&segments, "snapshot") =>
        {
            RelayRoutePolicy {
                authentication: CloudRelayAuthentication::Session,
                requires_idempotency_key: false,
                requires_body: false,
                query: RelayQueryKind::CursorWithLimit { maximum_limit: 256 },
            }
        }
        _ => return Err(cloud_relay_route_forbidden()),
    };
    validate_relay_query(&parsed, policy.query)?;
    Ok(policy)
}

fn is_project_state_route(segments: &[&str]) -> bool {
    segments.len() == 4
        && segments[1] == "v1"
        && segments[2] == "projects"
        && validate_uuid_v7(segments[3]).is_ok()
}

fn is_marketplace_artifact_download_route(segments: &[&str]) -> bool {
    segments.len() == 6
        && segments[1] == "v1"
        && segments[2] == "marketplace"
        && segments[3] == "artifacts"
        && validate_uuid_v7(segments[4]).is_ok()
        && segments[5] == "downloads"
}

fn is_marketplace_version_mutation_route(segments: &[&str], operation: &str) -> bool {
    segments.len() == 8
        && segments[1] == "v1"
        && segments[2] == "marketplace"
        && segments[3] == "artifacts"
        && validate_uuid_v7(segments[4]).is_ok()
        && segments[5] == "versions"
        && validate_uuid_v7(segments[6]).is_ok()
        && segments[7] == operation
}

fn is_team_member_list_route(segments: &[&str]) -> bool {
    segments.len() == 5
        && segments[1] == "v1"
        && segments[2] == "teams"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "members"
}

fn is_team_invitation_create_route(segments: &[&str]) -> bool {
    segments.len() == 5
        && segments[1] == "v1"
        && segments[2] == "teams"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "invitations"
}

fn is_team_invitation_accept_route(segments: &[&str]) -> bool {
    segments.len() == 5
        && segments[1] == "v1"
        && segments[2] == "team-invitations"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "acceptances"
}

fn is_team_member_mutation_route(segments: &[&str], operation: &str) -> bool {
    segments.len() == 7
        && segments[1] == "v1"
        && segments[2] == "teams"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "members"
        && validate_uuid_v7(segments[5]).is_ok()
        && segments[6] == operation
}

fn is_project_assignment_list_route(segments: &[&str]) -> bool {
    segments.len() == 7
        && segments[1] == "v1"
        && segments[2] == "teams"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "projects"
        && validate_uuid_v7(segments[5]).is_ok()
        && segments[6] == "assignments"
}

fn is_project_assignment_set_route(segments: &[&str]) -> bool {
    segments.len() == 8
        && is_project_assignment_list_route(&segments[..7])
        && validate_uuid_v7(segments[7]).is_ok()
}

fn is_team_project_key_recipient_list_route(segments: &[&str]) -> bool {
    is_team_project_key_version_route(segments, 9) && segments[8] == "recipients"
}

fn is_current_team_project_key_route(segments: &[&str]) -> bool {
    segments.len() == 8
        && segments[1] == "v1"
        && segments[2] == "teams"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "projects"
        && validate_uuid_v7(segments[5]).is_ok()
        && segments[6] == "keys"
        && segments[7] == "current"
}

fn is_team_project_key_envelope_publish_route(segments: &[&str]) -> bool {
    is_team_project_key_version_route(segments, 9) && segments[8] == "envelopes"
}

fn is_current_device_team_project_key_envelope_route(segments: &[&str]) -> bool {
    is_team_project_key_version_route(segments, 10)
        && segments[8] == "envelopes"
        && segments[9] == "current-device"
}

fn validate_current_team_project_key_metadata_path(input: &str) -> Result<(), CommandError> {
    validate_relay_route(CloudRelayMethod::Get, input)?;
    let parsed = Url::parse(&format!("https://inkshadow.invalid{input}"))
        .map_err(|_| cloud_relay_request_invalid())?;
    let segments = parsed.path().split('/').collect::<Vec<_>>();
    if !is_current_team_project_key_route(&segments) {
        return Err(cloud_relay_request_invalid());
    }
    Ok(())
}

fn validate_native_only_current_device_team_project_key_envelope_path(
    input: &str,
) -> Result<(), CommandError> {
    if input.is_empty()
        || input.len() > 4_096
        || !input.starts_with('/')
        || input.starts_with("//")
        || input.contains('\\')
        || input.contains('#')
        || input.contains('%')
        || !input.is_ascii()
        || input.bytes().any(|byte| byte.is_ascii_control())
        || has_dot_path_segment(input)
    {
        return Err(cloud_relay_request_invalid());
    }
    let parsed = Url::parse(&format!("https://inkshadow.invalid{input}"))
        .map_err(|_| cloud_relay_request_invalid())?;
    let segments = parsed.path().split('/').collect::<Vec<_>>();
    if parsed.origin().ascii_serialization() != "https://inkshadow.invalid"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !is_current_device_team_project_key_envelope_route(&segments)
    {
        return Err(cloud_relay_request_invalid());
    }
    Ok(())
}

fn is_team_project_key_version_route(segments: &[&str], expected_len: usize) -> bool {
    segments.len() == expected_len
        && segments[1] == "v1"
        && segments[2] == "teams"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "projects"
        && validate_uuid_v7(segments[5]).is_ok()
        && segments[6] == "keys"
        && validate_key_version(segments[7])
}

fn is_project_deletion_lookup_route(segments: &[&str]) -> bool {
    segments.len() == 5
        && segments[1] == "v1"
        && segments[2] == "projects"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "deletion-request"
}

fn is_project_deletion_cancellation_route(segments: &[&str]) -> bool {
    segments.len() == 5
        && segments[1] == "v1"
        && segments[2] == "projects"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "deletion-cancellations"
}

fn is_current_project_key_route(segments: &[&str]) -> bool {
    segments.len() == 6
        && segments[1] == "v1"
        && segments[2] == "projects"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "keys"
        && segments[5] == "current"
}

fn is_versioned_project_key_route(segments: &[&str]) -> bool {
    segments.len() == 6
        && segments[1] == "v1"
        && segments[2] == "projects"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "keys"
        && validate_key_version(segments[5])
}

fn is_project_sync_route(segments: &[&str], operation: &str) -> bool {
    segments.len() == 6
        && segments[1] == "v1"
        && segments[2] == "projects"
        && validate_uuid_v7(segments[3]).is_ok()
        && segments[4] == "sync"
        && segments[5] == operation
}

fn validate_key_version(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && !value.starts_with('0')
        && value
            .parse::<u32>()
            .is_ok_and(|version| version <= i32::MAX as u32)
}

fn validate_relay_query(parsed: &Url, kind: RelayQueryKind) -> Result<(), CommandError> {
    let pairs = parsed.query_pairs().collect::<Vec<_>>();
    match kind {
        RelayQueryKind::None if pairs.is_empty() => Ok(()),
        RelayQueryKind::None => Err(cloud_relay_request_invalid()),
        RelayQueryKind::Cursor
        | RelayQueryKind::CursorWithLimit { .. }
        | RelayQueryKind::MarketplaceCatalog { .. } => {
            let mut names = HashSet::new();
            for (name, value) in pairs {
                if !names.insert(name.to_string()) {
                    return Err(cloud_relay_request_invalid());
                }
                match name.as_ref() {
                    "cursor"
                        if !value.is_empty()
                            && value.len() <= 512
                            && value.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || b"_-".contains(&byte)
                            }) => {}
                    "limit"
                        if matches!(
                            kind,
                            RelayQueryKind::CursorWithLimit { maximum_limit }
                                | RelayQueryKind::MarketplaceCatalog { maximum_limit }
                                if value.parse::<u16>().is_ok_and(
                                    |limit| limit > 0 && limit <= maximum_limit
                                )
                        ) => {}
                    "kind"
                        if matches!(kind, RelayQueryKind::MarketplaceCatalog { .. })
                            && matches!(
                                value.as_ref(),
                                "story_template" | "style_template" | "world_template"
                            ) => {}
                    _ => return Err(cloud_relay_request_invalid()),
                }
            }
            Ok(())
        }
    }
}

fn validate_relay_body(body: &serde_json::Value, requires_body: bool) -> Result<(), CommandError> {
    if requires_body != !body.is_null()
        || (requires_body && !body.is_object())
        || contains_forbidden_credential_field(body)
    {
        return Err(cloud_relay_request_invalid());
    }
    Ok(())
}

fn validate_relay_headers(
    headers: &BTreeMap<String, String>,
    requires_idempotency_key: bool,
) -> Result<BTreeMap<String, String>, CommandError> {
    if headers.len() > 2 {
        return Err(cloud_relay_request_invalid());
    }
    let mut normalized = BTreeMap::new();
    for (name, value) in headers {
        let canonical = match name.to_ascii_lowercase().as_str() {
            "x-request-id" => "X-Request-Id",
            "idempotency-key" => "Idempotency-Key",
            "authorization" => return Err(cloud_authorization_forbidden()),
            _ => return Err(cloud_relay_request_invalid()),
        };
        if value.is_empty()
            || value.len() > 512
            || !value.is_ascii()
            || value.bytes().any(|byte| byte.is_ascii_control())
            || normalized
                .insert(canonical.to_owned(), value.clone())
                .is_some()
        {
            return Err(cloud_relay_request_invalid());
        }
    }
    let request_id = normalized
        .get("X-Request-Id")
        .ok_or_else(cloud_relay_request_invalid)?;
    validate_uuid_v7(request_id).map_err(|_| cloud_relay_request_invalid())?;
    match normalized.get("Idempotency-Key") {
        Some(value) if requires_idempotency_key => validate_idempotency_key(value)?,
        None if !requires_idempotency_key => {}
        _ => return Err(cloud_relay_request_invalid()),
    }
    Ok(normalized)
}

fn validate_idempotency_key(value: &str) -> Result<(), CommandError> {
    if !(16..=200).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~-".contains(&byte))
    {
        return Err(cloud_relay_request_invalid());
    }
    Ok(())
}

fn contains_forbidden_credential_field(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => object.iter().any(|(key, child)| {
            let normalized = key
                .chars()
                .filter(|character| *character != '_' && *character != '-')
                .flat_map(char::to_lowercase)
                .collect::<String>();
            matches!(
                normalized.as_str(),
                "authorization" | "accesstoken" | "password" | "refreshtoken" | "tokens"
            ) || contains_forbidden_credential_field(child)
        }),
        serde_json::Value::Array(values) => values.iter().any(contains_forbidden_credential_field),
        _ => false,
    }
}

fn response_contains_session_token(
    value: &serde_json::Value,
    stored: Option<&StoredCloudSession>,
) -> bool {
    let Some(stored) = stored else {
        return false;
    };
    match value {
        serde_json::Value::String(value) => {
            value == &stored.tokens.access_token || value == &stored.tokens.refresh_token
        }
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| response_contains_session_token(value, Some(stored))),
        serde_json::Value::Object(object) => object
            .values()
            .any(|value| response_contains_session_token(value, Some(stored))),
        _ => false,
    }
}

fn response_contains_sensitive_value(value: &serde_json::Value, sensitive: &str) -> bool {
    match value {
        serde_json::Value::String(value) => value.contains(sensitive),
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| response_contains_sensitive_value(value, sensitive)),
        serde_json::Value::Object(object) => object.iter().any(|(key, value)| {
            key.contains(sensitive) || response_contains_sensitive_value(value, sensitive)
        }),
        _ => false,
    }
}

fn response_headers_contain_sensitive_value(
    headers: &BTreeMap<String, String>,
    sensitive: &str,
) -> bool {
    headers.values().any(|value| value.contains(sensitive))
}

async fn send_cloud_relay_http(
    endpoint: &ValidatedCloudBaseUrl,
    method: CloudRelayMethod,
    path: &str,
    headers: &BTreeMap<String, String>,
    body: &serde_json::Value,
    stored: Option<&StoredCloudSession>,
) -> Result<CloudApiRelayResponse, CommandError> {
    let relative = Url::parse(&format!("https://inkshadow.invalid{path}"))
        .map_err(|_| cloud_relay_request_invalid())?;
    let client = build_cloud_client(endpoint)?;
    let mut request = client
        .request(method.as_reqwest(), endpoint.relay_url(&relative))
        .header(ACCEPT, "application/json");
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if !body.is_null() {
        let serialized =
            Zeroizing::new(serde_json::to_vec(body).map_err(|_| cloud_relay_request_invalid())?);
        if serialized.len() > 64 * 1024 * 1024 {
            return Err(cloud_relay_request_invalid());
        }
        request = request
            .header(CONTENT_TYPE, "application/json")
            .body(Bytes::from_owner(serialized));
    }
    if let Some(stored) = stored {
        validate_token(&stored.tokens.access_token).map_err(|_| session_vault_corrupted())?;
        let authorization = Zeroizing::new(format!("Bearer {}", stored.tokens.access_token));
        let value =
            HeaderValue::from_str(authorization.as_str()).map_err(|_| session_vault_corrupted())?;
        request = request.header(AUTHORIZATION, value);
    }
    let response = request.send().await.map_err(cloud_network_error)?;
    let status = response.status().as_u16();
    validate_content_type(response.headers(), relay_request_id(headers))?;
    let response_headers =
        select_relay_response_headers(response.headers(), relay_request_id(headers))?;
    let response_body = collect_limited_body(response).await?;
    let parsed: serde_json::Value = serde_json::from_slice(response_body.as_slice())
        .map_err(|_| cloud_protocol_invalid(relay_request_id(headers)))?;
    if contains_forbidden_credential_field(&parsed)
        || response_contains_session_token(&parsed, stored)
    {
        return Err(cloud_protocol_invalid(relay_request_id(headers)));
    }
    Ok(CloudApiRelayResponse {
        status,
        headers: response_headers,
        body: parsed,
    })
}

async fn fetch_current_device_team_project_key_envelope(
    endpoint: &ValidatedCloudBaseUrl,
    path: &str,
    request_id: &str,
    stored: &StoredCloudSession,
) -> Result<CloudTeamProjectKeyEnvelopeResponse, CommandError> {
    validate_native_only_current_device_team_project_key_envelope_path(path)?;
    fetch_native_team_project_key_json(
        endpoint,
        path,
        request_id,
        stored,
        MAX_TEAM_PROJECT_KEY_ENVELOPE_RESPONSE_BYTES,
    )
    .await
}

fn validate_current_team_project_key_metadata(
    response: &CloudTeamProjectCurrentKeyResponse,
    request_id: &str,
    expected_team_id: &str,
    expected_project_id: &str,
) -> Result<(), CommandError> {
    if response.schema_version != CLOUD_SCHEMA_VERSION
        || response.request_id != request_id
        || response.team_id != expected_team_id
        || response.project_id != expected_project_id
        || response.state != "active"
        || !validate_key_version(&response.key_version.to_string())
        || response.server_revision == 0
        || response.server_revision > MAX_PORTABLE_INTEGER
    {
        return Err(cloud_protocol_invalid(request_id));
    }
    validate_uuid_v7(&response.request_id).map_err(|_| cloud_protocol_invalid(request_id))?;
    validate_uuid_v7(&response.team_id).map_err(|_| cloud_protocol_invalid(request_id))?;
    validate_uuid_v7(&response.project_id).map_err(|_| cloud_protocol_invalid(request_id))?;
    parse_iso_utc_timestamp(&response.updated_at)
        .map_err(|_| cloud_protocol_invalid(request_id))?;
    Ok(())
}

fn ensure_current_team_project_key_metadata_unchanged(
    before: &CloudTeamProjectCurrentKeyResponse,
    after: &CloudTeamProjectCurrentKeyResponse,
    request_id: &str,
) -> Result<(), CommandError> {
    if before.team_id != after.team_id
        || before.project_id != after.project_id
        || before.key_version != after.key_version
        || before.state != after.state
        || before.server_revision != after.server_revision
        || before.updated_at != after.updated_at
        || before.current_device_envelope_available != after.current_device_envelope_available
    {
        return Err(current_team_project_key_changed(request_id));
    }
    Ok(())
}

async fn fetch_current_team_project_key_metadata(
    endpoint: &ValidatedCloudBaseUrl,
    path: &str,
    request_id: &str,
    stored: &StoredCloudSession,
) -> Result<CloudTeamProjectCurrentKeyResponse, CommandError> {
    validate_current_team_project_key_metadata_path(path)?;
    fetch_native_team_project_key_json(
        endpoint,
        path,
        request_id,
        stored,
        MAX_TEAM_PROJECT_CURRENT_KEY_RESPONSE_BYTES,
    )
    .await
}

async fn fetch_native_team_project_key_json<ResponseBody>(
    endpoint: &ValidatedCloudBaseUrl,
    path: &str,
    request_id: &str,
    stored: &StoredCloudSession,
    maximum_response_bytes: usize,
) -> Result<ResponseBody, CommandError>
where
    ResponseBody: DeserializeOwned,
{
    validate_token(&stored.tokens.access_token).map_err(|_| session_vault_corrupted())?;
    let relative = Url::parse(&format!("https://inkshadow.invalid{path}"))
        .map_err(|_| cloud_relay_request_invalid())?;
    let client = build_cloud_client(endpoint)?;
    let authorization = Zeroizing::new(format!("Bearer {}", stored.tokens.access_token));
    let authorization_header =
        HeaderValue::from_str(authorization.as_str()).map_err(|_| session_vault_corrupted())?;
    let response = client
        .get(endpoint.relay_url(&relative))
        .header(ACCEPT, "application/json")
        .header("X-Request-Id", request_id)
        .header(AUTHORIZATION, authorization_header)
        .send()
        .await
        .map_err(cloud_network_error)?;
    let status = response.status();
    let headers = response.headers().clone();
    validate_content_type(&headers, request_id)?;
    validate_response_header_request_id(&headers, request_id)?;
    let response_body = collect_limited_body_with_limit(response, maximum_response_bytes).await?;
    if status != StatusCode::OK {
        if status.is_redirection() {
            return Err(CommandError::new_with_request_id(
                "CLOUD_HTTP_REDIRECT_FORBIDDEN",
                "Cloud API redirects are forbidden.",
                false,
                vec!["OPEN_SETTINGS"],
                request_id.to_owned(),
            ));
        }
        return Err(parse_cloud_server_error(
            response_body.as_slice(),
            request_id,
        )?);
    }
    serde_json::from_slice(response_body.as_slice()).map_err(|_| cloud_protocol_invalid(request_id))
}

async fn send_cloud_deletion_json<Request>(
    endpoint: &ValidatedCloudBaseUrl,
    path: &str,
    request_id: &str,
    idempotency_key: Option<&str>,
    body: &Request,
    stored: Option<&StoredCloudSession>,
    password: &str,
) -> Result<CloudApiRelayResponse, CommandError>
where
    Request: Serialize,
{
    validate_uuid_v7(request_id)?;
    if let Some(value) = idempotency_key {
        validate_idempotency_key(value)?;
    }
    let relative = Url::parse(&format!("https://inkshadow.invalid{path}"))
        .map_err(|_| cloud_relay_request_invalid())?;
    if relative.origin().ascii_serialization() != "https://inkshadow.invalid"
        || relative.query().is_some()
        || relative.fragment().is_some()
    {
        return Err(cloud_relay_request_invalid());
    }
    let client = build_cloud_client(endpoint)?;
    let serialized =
        Zeroizing::new(serde_json::to_vec(body).map_err(|_| cloud_relay_request_invalid())?);
    if serialized.is_empty() || serialized.len() > 64 * 1024 {
        return Err(cloud_relay_request_invalid());
    }
    let mut request = client
        .post(endpoint.relay_url(&relative))
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header("X-Request-Id", request_id)
        .body(Bytes::from_owner(serialized));
    let authorization = if let Some(stored) = stored {
        validate_token(&stored.tokens.access_token).map_err(|_| session_vault_corrupted())?;
        let authorization = Zeroizing::new(format!("Bearer {}", stored.tokens.access_token));
        let authorization_header =
            HeaderValue::from_str(authorization.as_str()).map_err(|_| session_vault_corrupted())?;
        request = request.header(AUTHORIZATION, authorization_header);
        Some(authorization)
    } else {
        None
    };
    if let Some(value) = idempotency_key {
        request = request.header("Idempotency-Key", value);
    }
    let response = request.send().await.map_err(cloud_network_error)?;
    let status = response.status().as_u16();
    validate_content_type(response.headers(), request_id)?;
    validate_response_header_request_id(response.headers(), request_id)?;
    let response_headers = select_relay_response_headers(response.headers(), request_id)?;
    let response_body = collect_limited_body(response).await?;
    let parsed: serde_json::Value = serde_json::from_slice(response_body.as_slice())
        .map_err(|_| cloud_protocol_invalid(request_id))?;
    if contains_forbidden_credential_field(&parsed)
        || response_contains_session_token(&parsed, stored)
        || response_contains_sensitive_value(&parsed, password)
        || response_headers_contain_sensitive_value(&response_headers, password)
    {
        return Err(cloud_protocol_invalid(request_id));
    }
    drop(authorization);
    Ok(CloudApiRelayResponse {
        status,
        headers: response_headers,
        body: parsed,
    })
}

fn select_relay_response_headers(
    headers: &HeaderMap,
    request_id: &str,
) -> Result<BTreeMap<String, String>, CommandError> {
    let mut selected = BTreeMap::new();
    for name in ["content-type", "retry-after", "x-request-id"] {
        if let Some(value) = headers.get(name) {
            let value = value
                .to_str()
                .map_err(|_| cloud_protocol_invalid(request_id))?;
            if value.len() > 1_024 || value.bytes().any(|byte| byte.is_ascii_control()) {
                return Err(cloud_protocol_invalid(request_id));
            }
            selected.insert(name.to_owned(), value.to_owned());
        }
    }
    Ok(selected)
}

fn relay_request_id(headers: &BTreeMap<String, String>) -> &str {
    headers
        .get("X-Request-Id")
        .map(String::as_str)
        .unwrap_or("00000000-0000-7000-8000-000000000000")
}

async fn send_cloud_json<Request, Output>(
    endpoint: &ValidatedCloudBaseUrl,
    route: CloudRoute,
    request_id: &str,
    body: &Request,
    access_token: Option<&str>,
) -> Result<Output, CommandError>
where
    Request: Serialize,
    Output: DeserializeOwned,
{
    validate_uuid_v7(request_id)?;
    let client = build_cloud_client(endpoint)?;
    let serialized = Zeroizing::new(serde_json::to_vec(body).map_err(|_| cloud_request_invalid())?);
    if serialized.len() > 64 * 1024 {
        return Err(cloud_request_invalid());
    }
    let mut request = client
        .post(endpoint.api_url(route))
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header("X-Request-Id", request_id)
        .header("Idempotency-Key", Uuid::now_v7().to_string())
        .body(Bytes::from_owner(serialized));
    if let Some(token) = access_token {
        validate_token(token)?;
        let authorization = Zeroizing::new(format!("Bearer {token}"));
        let value =
            HeaderValue::from_str(authorization.as_str()).map_err(|_| session_vault_corrupted())?;
        request = request.header(AUTHORIZATION, value);
    }
    let response = request.send().await.map_err(cloud_network_error)?;
    let status = response.status();
    let headers = response.headers().clone();
    let response_body = collect_limited_body(response).await?;
    validate_content_type(&headers, request_id)?;
    validate_response_header_request_id(&headers, request_id)?;
    if status != route.expected_status() {
        if status.is_redirection() {
            return Err(CommandError::new_with_request_id(
                "CLOUD_HTTP_REDIRECT_FORBIDDEN",
                "Cloud API redirects are forbidden.",
                false,
                vec!["OPEN_SETTINGS"],
                request_id.to_owned(),
            ));
        }
        return Err(parse_cloud_server_error(
            response_body.as_slice(),
            request_id,
        )?);
    }
    serde_json::from_slice(response_body.as_slice()).map_err(|_| cloud_protocol_invalid(request_id))
}

fn build_cloud_client(endpoint: &ValidatedCloudBaseUrl) -> Result<Client, CommandError> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .https_only(!endpoint.allow_insecure_loopback)
        .no_proxy()
        .dns_resolver(RestrictedDnsResolver)
        .referer(false)
        .user_agent(concat!("InkShadow/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| cloud_network_unavailable())
}

async fn collect_limited_body(response: Response) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    collect_limited_body_with_limit(response, MAX_RESPONSE_BYTES).await
}

async fn collect_limited_body_with_limit(
    mut response: Response,
    limit: usize,
) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(cloud_response_too_large());
    }
    let mut body = Zeroizing::new(Vec::new());
    loop {
        let chunk = response.chunk().await.map_err(cloud_network_error)?;
        let Some(chunk) = chunk else {
            return Ok(body);
        };
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(cloud_response_too_large());
        }
        body.extend_from_slice(&chunk);
    }
}

fn validate_content_type(headers: &HeaderMap, request_id: &str) -> Result<(), CommandError> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    if matches!(
        content_type.as_deref(),
        Some("application/json" | "application/problem+json")
    ) {
        Ok(())
    } else {
        Err(cloud_protocol_invalid(request_id))
    }
}

fn validate_response_header_request_id(
    headers: &HeaderMap,
    request_id: &str,
) -> Result<(), CommandError> {
    match headers.get("X-Request-Id") {
        None => Ok(()),
        Some(value) if value.to_str().ok() == Some(request_id) => Ok(()),
        _ => Err(cloud_protocol_invalid(request_id)),
    }
}

fn parse_cloud_server_error(body: &[u8], request_id: &str) -> Result<CommandError, CommandError> {
    let response: CloudApiErrorResponse =
        serde_json::from_slice(body).map_err(|_| cloud_protocol_invalid(request_id))?;
    if response.schema_version != CLOUD_SCHEMA_VERSION
        || response.request_id != request_id
        || response.error.message.is_empty()
        || response.error.message.chars().count() > 500
        || response.error.actions.len() > 8
        || response
            .error
            .support_id
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.chars().count() > 100)
    {
        return Err(cloud_protocol_invalid(request_id));
    }
    let actions = response
        .error
        .actions
        .iter()
        .map(|action| action.as_str())
        .collect();
    Ok(CommandError::new_with_request_id(
        response.error.code.as_str(),
        cloud_error_message(response.error.code),
        response.error.retryable,
        actions,
        response.request_id,
    ))
}

fn cloud_error_message(code: CloudApiErrorCode) -> &'static str {
    match code {
        CloudApiErrorCode::AuthInvalidCredentials => "The email address or password is invalid.",
        CloudApiErrorCode::AuthEmailUnverified => "The cloud account email is not verified.",
        CloudApiErrorCode::AuthRateLimited | CloudApiErrorCode::RateLimited => {
            "Too many cloud requests were attempted."
        }
        CloudApiErrorCode::AuthAccountLocked => "The cloud account is temporarily locked.",
        CloudApiErrorCode::AuthAccountFrozen => "The cloud account is frozen.",
        CloudApiErrorCode::AuthSessionExpired => "The cloud session expired.",
        CloudApiErrorCode::AuthSessionRevoked => "The cloud session was revoked.",
        CloudApiErrorCode::AuthRefreshReplayed => {
            "The refresh credential was replayed and device sessions were revoked."
        }
        CloudApiErrorCode::AuthDeviceRevoked => "This cloud device was revoked.",
        CloudApiErrorCode::AuthUpgradeRequired => "A newer InkShadow client is required.",
        CloudApiErrorCode::AuthNetworkUnavailable | CloudApiErrorCode::ServiceUnavailable => {
            "The cloud service is temporarily unavailable."
        }
        CloudApiErrorCode::AccessForbidden => "The cloud operation is not permitted.",
        CloudApiErrorCode::ResourceNotFound => "The requested cloud resource was not found.",
        CloudApiErrorCode::RevisionConflict
        | CloudApiErrorCode::IdempotencyConflict
        | CloudApiErrorCode::SyncSequenceConflict => {
            "The cloud operation conflicted with newer state."
        }
        CloudApiErrorCode::SyncCursorExpired => "The cloud sync cursor expired.",
        CloudApiErrorCode::SyncInvalidCiphertext => "The encrypted sync payload is invalid.",
        CloudApiErrorCode::SyncQuotaExceeded => "The cloud sync quota was exceeded.",
        CloudApiErrorCode::ValidationFailed => "The cloud request was invalid.",
        CloudApiErrorCode::InternalError => "The cloud service encountered an internal error.",
    }
}

fn validate_session_grant(
    grant: &CloudSessionGrantResponse,
    request_id: &str,
    expected_device: &ExpectedDeviceIdentity,
    expected_account_id: Option<&str>,
) -> Result<(), CommandError> {
    if grant.schema_version != CLOUD_SCHEMA_VERSION || grant.request_id != request_id {
        return Err(cloud_protocol_invalid(request_id));
    }
    validate_uuid_v7(&grant.request_id).map_err(|_| cloud_protocol_invalid(request_id))?;
    validate_session_material(
        &grant.account,
        &grant.device,
        &grant.session,
        &grant.tokens,
        expected_device,
        expected_account_id,
    )
    .map_err(|_| cloud_protocol_invalid(request_id))
}

fn validate_session_material(
    account: &CloudAccountMetadata,
    device: &CloudDeviceMetadata,
    session: &CloudSessionMetadata,
    tokens: &CloudSessionTokenSet,
    expected_device: &ExpectedDeviceIdentity,
    expected_account_id: Option<&str>,
) -> Result<(), CommandError> {
    validate_account(account)?;
    validate_device(device, expected_device)?;
    validate_session(session)?;
    validate_token_set(tokens)?;
    if expected_account_id.is_some_and(|expected| account.account_id != expected)
        || account.account_id != device.device.account_id
        || account.account_id != session.account_id
        || device.device.device_id != session.device_id
        || session.expires_at != tokens.access_token_expires_at
        || session.client_version != expected_device.client_version
        || compare_semantic_versions(&session.client_version, &session.minimum_client_version)? < 0
    {
        return Err(session_input_invalid());
    }
    Ok(())
}

fn validate_account(account: &CloudAccountMetadata) -> Result<(), CommandError> {
    if account.schema_version != CLOUD_SCHEMA_VERSION
        || account.revision == 0
        || account.state != CloudAccountState::Active
    {
        return Err(session_input_invalid());
    }
    validate_uuid_v7(&account.account_id)?;
    let verified_at = account
        .verified_at
        .as_deref()
        .ok_or_else(session_input_invalid)
        .and_then(parse_iso_utc_timestamp)?;
    if account.deletion_scheduled_for.is_some() {
        return Err(session_input_invalid());
    }
    let created_at = parse_iso_utc_timestamp(&account.created_at)?;
    let updated_at = parse_iso_utc_timestamp(&account.updated_at)?;
    if verified_at < created_at || updated_at < created_at {
        return Err(session_input_invalid());
    }
    Ok(())
}

fn validate_device(
    device: &CloudDeviceMetadata,
    expected: &ExpectedDeviceIdentity,
) -> Result<(), CommandError> {
    validate_expected_device(expected)?;
    if device.schema_version != CLOUD_SCHEMA_VERSION
        || device.revision == 0
        || device.device.schema_version != CLOUD_SCHEMA_VERSION
        || device.public_key.schema_version != CLOUD_SCHEMA_VERSION
        || device.device.state != CloudDeviceState::Trusted
        || device.device.revoked_at.is_some()
        || device.public_key.revoked_at.is_some()
        || device.device.device_id != device.public_key.device_id
        || device.device.account_id != device.public_key.account_id
        || device.device.public_key_fingerprint != device.public_key.public_key_fingerprint
        || device.device.created_at != device.public_key.created_at
        || device.device.device_id != expected.device_id
        || device.display_name != expected.display_name
        || device.public_key.algorithm != expected.algorithm
        || device.public_key.public_key != expected.public_key
        || device.public_key.public_key_fingerprint != expected.public_key_fingerprint
    {
        return Err(session_input_invalid());
    }
    validate_uuid_v7(&device.device.device_id)?;
    validate_uuid_v7(&device.device.account_id)?;
    parse_iso_utc_timestamp(&device.device.created_at)?;
    validate_device_public_key(
        &device.public_key.public_key,
        &device.public_key.public_key_fingerprint,
    )
}

fn validate_expected_device(expected: &ExpectedDeviceIdentity) -> Result<(), CommandError> {
    validate_uuid_v7(&expected.device_id)?;
    validate_display_name(&expected.display_name)?;
    validate_semantic_version(&expected.client_version)?;
    if expected.algorithm != DEVICE_KEY_ALGORITHM {
        return Err(session_input_invalid());
    }
    validate_device_public_key(&expected.public_key, &expected.public_key_fingerprint)
}

fn validate_device_public_key(public_key: &str, fingerprint: &str) -> Result<(), CommandError> {
    if public_key.len() != 87
        || !public_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        || fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(session_input_invalid());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(public_key)
        .map_err(|_| session_input_invalid())?;
    if decoded.len() != 65
        || DevicePublicKey::from_bytes(&decoded).is_err()
        || sha256_hex(&decoded) != fingerprint
    {
        return Err(session_input_invalid());
    }
    Ok(())
}

fn validate_session(session: &CloudSessionMetadata) -> Result<(), CommandError> {
    if session.schema_version != CLOUD_SCHEMA_VERSION || session.revoked_at.is_some() {
        return Err(session_input_invalid());
    }
    validate_uuid_v7(&session.session_id)?;
    validate_uuid_v7(&session.account_id)?;
    validate_uuid_v7(&session.device_id)?;
    validate_semantic_version(&session.client_version)?;
    validate_semantic_version(&session.minimum_client_version)?;
    let issued_at = parse_iso_utc_timestamp(&session.issued_at)?;
    let expires_at = parse_iso_utc_timestamp(&session.expires_at)?;
    if expires_at <= issued_at {
        return Err(session_input_invalid());
    }
    Ok(())
}

fn validate_token_set(tokens: &CloudSessionTokenSet) -> Result<(), CommandError> {
    validate_token(&tokens.access_token)?;
    validate_token(&tokens.refresh_token)?;
    if tokens.access_token == tokens.refresh_token {
        return Err(session_input_invalid());
    }
    let access_expiry = parse_iso_utc_timestamp(&tokens.access_token_expires_at)?;
    let refresh_expiry = parse_iso_utc_timestamp(&tokens.refresh_token_expires_at)?;
    if refresh_expiry <= access_expiry {
        return Err(session_input_invalid());
    }
    Ok(())
}

fn validate_accepted_response(
    response: &CloudMutationAcceptedResponse,
    request_id: &str,
) -> Result<(), CommandError> {
    if response.schema_version != CLOUD_SCHEMA_VERSION
        || response.request_id != request_id
        || !response.accepted
    {
        return Err(cloud_protocol_invalid(request_id));
    }
    validate_uuid_v7(&response.request_id).map_err(|_| cloud_protocol_invalid(request_id))?;
    parse_iso_utc_timestamp(&response.completed_at)
        .map_err(|_| cloud_protocol_invalid(request_id))?;
    Ok(())
}

fn normalize_email(value: &str) -> Result<String, CommandError> {
    let normalized = value.trim().to_lowercase();
    let mut parts = normalized.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if normalized.len() < 3
        || normalized.len() > 320
        || local.is_empty()
        || domain.is_empty()
        || !domain.contains('.')
        || parts.next().is_some()
        || normalized.chars().any(char::is_control)
    {
        return Err(cloud_request_invalid());
    }
    Ok(normalized)
}

fn validate_password(value: &str) -> Result<(), CommandError> {
    let count = value.encode_utf16().count();
    if !(12..=256).contains(&count) || value.chars().any(char::is_control) {
        return Err(cloud_request_invalid());
    }
    Ok(())
}

fn validate_deletion_credential_common(
    request_id: &str,
    idempotency_key: Option<&str>,
    revision: u64,
    password: &str,
) -> Result<(), CommandError> {
    validate_uuid_v7(request_id)?;
    let idempotency_key = idempotency_key.ok_or_else(cloud_relay_request_invalid)?;
    validate_idempotency_key(idempotency_key)?;
    if revision == 0 || revision > 9_007_199_254_740_991 {
        return Err(cloud_relay_request_invalid());
    }
    validate_password(password)
}

fn validate_deletion_lookup_proof<'a>(
    deletion_request_id: Option<&'a str>,
    confirmation_id: Option<&'a str>,
) -> Result<(Option<&'a str>, Option<&'a str>), CommandError> {
    match (deletion_request_id, confirmation_id) {
        (Some(deletion_request_id), None) => {
            validate_uuid_v7(deletion_request_id)?;
            Ok((Some(deletion_request_id), None))
        }
        (None, Some(confirmation_id)) => {
            validate_uuid_v7(confirmation_id)?;
            Ok((None, Some(confirmation_id)))
        }
        _ => Err(cloud_request_invalid()),
    }
}

fn validate_display_name(value: &str) -> Result<(), CommandError> {
    let count = value.chars().count();
    if value.trim() != value || !(1..=80).contains(&count) || value.chars().any(char::is_control) {
        return Err(cloud_request_invalid());
    }
    Ok(())
}

fn validate_one_time_code(value: &str) -> Result<(), CommandError> {
    if value.len() != 6 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(cloud_request_invalid());
    }
    Ok(())
}

fn validate_uuid_v7(value: &str) -> Result<String, CommandError> {
    let parsed = Uuid::parse_str(value).map_err(|_| session_input_invalid())?;
    if parsed.get_version() != Some(UuidVersion::SortRand)
        || parsed.get_variant() != UuidVariant::RFC4122
        || parsed.to_string() != value
    {
        return Err(session_input_invalid());
    }
    Ok(value.to_owned())
}

fn validate_token(value: &str) -> Result<(), CommandError> {
    if value.len() < 43
        || value.len() > MAX_TOKEN_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~-".contains(&byte))
    {
        return Err(session_input_invalid());
    }
    Ok(())
}

fn validate_semantic_version(value: &str) -> Result<[u64; 3], CommandError> {
    let mut parts = value.split('.');
    let mut parsed = [0_u64; 3];
    for item in &mut parsed {
        let part = parts.next().ok_or_else(session_input_invalid)?;
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(session_input_invalid());
        }
        *item = part.parse().map_err(|_| session_input_invalid())?;
    }
    if parts.next().is_some() {
        return Err(session_input_invalid());
    }
    Ok(parsed)
}

fn compare_semantic_versions(left: &str, right: &str) -> Result<i8, CommandError> {
    let left = validate_semantic_version(left)?;
    let right = validate_semantic_version(right)?;
    Ok(if left < right {
        -1
    } else if left > right {
        1
    } else {
        0
    })
}

fn parse_iso_utc_timestamp(value: &str) -> Result<i64, CommandError> {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return Err(session_input_invalid());
    }
    for index in [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22] {
        if !bytes[index].is_ascii_digit() {
            return Err(session_input_invalid());
        }
    }
    let year = parse_digits(bytes, 0, 4) as i64;
    let month = parse_digits(bytes, 5, 2);
    let day = parse_digits(bytes, 8, 2);
    let hour = parse_digits(bytes, 11, 2);
    let minute = parse_digits(bytes, 14, 2);
    let second = parse_digits(bytes, 17, 2);
    let millisecond = parse_digits(bytes, 20, 3);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year as u32) => 29,
        2 => 28,
        _ => 0,
    };
    if year < 1970 || day == 0 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
        return Err(session_input_invalid());
    }
    let days = days_from_civil(year, month, day);
    Ok(
        (((days * 24 + i64::from(hour)) * 60 + i64::from(minute)) * 60 + i64::from(second)) * 1_000
            + i64::from(millisecond),
    )
}

fn parse_digits(bytes: &[u8], start: usize, length: usize) -> u32 {
    bytes[start..start + length]
        .iter()
        .fold(0, |value, byte| value * 10 + u32::from(byte - b'0'))
}

fn is_leap_year(year: u32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn sha256_hex(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn cloud_network_error(error: reqwest::Error) -> CommandError {
    if error.is_timeout() {
        CommandError::new(
            "CLOUD_REQUEST_TIMEOUT",
            "The cloud request timed out.",
            true,
            vec!["RETRY", "USE_LOCAL"],
        )
    } else {
        cloud_network_unavailable()
    }
}

fn cloud_network_unavailable() -> CommandError {
    CommandError::new(
        "CLOUD_NETWORK_UNAVAILABLE",
        "The cloud service could not be reached.",
        true,
        vec!["RETRY", "USE_LOCAL"],
    )
}

fn cloud_response_too_large() -> CommandError {
    CommandError::new(
        "CLOUD_RESPONSE_TOO_LARGE",
        "The cloud response exceeded the native gateway limit.",
        false,
        vec!["OPEN_DIAGNOSTICS"],
    )
}

fn cloud_protocol_invalid(request_id: &str) -> CommandError {
    CommandError::new_with_request_id(
        "CLOUD_PROTOCOL_INVALID_RESPONSE",
        "The cloud service returned an invalid response.",
        false,
        vec!["RETRY", "OPEN_DIAGNOSTICS"],
        request_id.to_owned(),
    )
}

fn current_device_team_project_key_envelope_unavailable(request_id: &str) -> CommandError {
    CommandError::new_with_request_id(
        "RESOURCE_NOT_FOUND",
        "The requested cloud resource was not found.",
        false,
        vec!["RETRY"],
        request_id.to_owned(),
    )
}

fn current_team_project_key_changed(request_id: &str) -> CommandError {
    CommandError::new_with_request_id(
        "REVISION_CONFLICT",
        "The cloud operation conflicted with newer state.",
        true,
        vec!["RETRY"],
        request_id.to_owned(),
    )
}

fn cloud_endpoint_invalid() -> CommandError {
    CommandError::new(
        "CLOUD_ENDPOINT_INVALID",
        "The cloud endpoint does not satisfy the network safety policy.",
        false,
        vec!["OPEN_SETTINGS"],
    )
}

fn cloud_request_invalid() -> CommandError {
    CommandError::new(
        "CLOUD_REQUEST_INVALID",
        "The cloud identity request is invalid.",
        false,
        vec!["EDIT_ACCOUNT"],
    )
}

fn cloud_relay_request_invalid() -> CommandError {
    CommandError::new(
        "CLOUD_RELAY_REQUEST_INVALID",
        "The native cloud relay request is invalid.",
        false,
        vec!["OPEN_DIAGNOSTICS"],
    )
}

fn cloud_relay_route_forbidden() -> CommandError {
    CommandError::new(
        "CLOUD_RELAY_ROUTE_FORBIDDEN",
        "This cloud route must use its dedicated native command or is not supported.",
        false,
        vec!["OPEN_DIAGNOSTICS"],
    )
}

fn cloud_authorization_forbidden() -> CommandError {
    CommandError::new(
        "CLOUD_AUTHORIZATION_INPUT_FORBIDDEN",
        "Authorization credentials cannot be supplied by the WebView.",
        false,
        vec!["OPEN_DIAGNOSTICS"],
    )
}

fn cloud_endpoint_session_mismatch() -> CommandError {
    CommandError::new(
        "CLOUD_SESSION_ENDPOINT_MISMATCH",
        "The cloud session is bound to a different service endpoint.",
        false,
        vec!["OPEN_SETTINGS", "SIGN_IN_AGAIN"],
    )
}

fn session_input_invalid() -> CommandError {
    CommandError::new(
        "CLOUD_SESSION_INPUT_INVALID",
        "The cloud session payload is invalid.",
        false,
        vec!["SIGN_IN_AGAIN"],
    )
}

fn session_vault_corrupted() -> CommandError {
    CommandError::new(
        "CLOUD_SESSION_CREDENTIAL_CORRUPTED",
        "The stored cloud session credential is invalid.",
        false,
        vec!["CLEAR_CLOUD_SESSION", "SIGN_IN_AGAIN"],
    )
}

fn stale_session_error() -> CommandError {
    CommandError::new(
        "CLOUD_SESSION_CHANGED",
        "The active cloud session changed before the operation completed.",
        false,
        vec!["RELOAD_ACCOUNT"],
    )
}

fn session_not_configured() -> CommandError {
    CommandError::new(
        "CLOUD_SESSION_NOT_CONFIGURED",
        "No cloud session is stored on this device.",
        false,
        vec!["SIGN_IN"],
    )
}

fn session_already_configured() -> CommandError {
    CommandError::new(
        "CLOUD_SESSION_ALREADY_CONFIGURED",
        "A cloud session is already stored on this device.",
        false,
        vec!["SIGN_OUT", "RELOAD_ACCOUNT"],
    )
}

fn device_identity_mismatch() -> CommandError {
    CommandError::new(
        "CLOUD_DEVICE_IDENTITY_MISMATCH",
        "The cloud session is not bound to this device identity.",
        false,
        vec!["CLEAR_CLOUD_SESSION", "SIGN_IN_AGAIN"],
    )
}

#[cfg(test)]
mod tests {
    use hpke::{Kem as _, Serializable};
    use rand::{rngs::StdRng, SeedableRng};
    use serde_json::{json, Value};

    use super::*;

    const ACCOUNT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000101";
    const DEVICE_ID: &str = "019f9f4a-b3c7-7350-9226-000000000102";
    const SESSION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000103";
    const NEXT_SESSION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000104";
    const REQUEST_ID: &str = "019f9f4a-b3c7-7350-9226-000000000105";
    const ACCESS_CANARY: &str = "access-token-canary-aaaaaaaaaaaaaaaaaaaaaaaa";
    const REFRESH_CANARY: &str = "refresh-token-canary-rrrrrrrrrrrrrrrrrrrrrrrr";

    #[test]
    fn cloud_base_url_policy_requires_https_or_explicit_debug_loopback() {
        let https = endpoint("https://cloud.example.test/api/", false);
        let normalized = ValidatedCloudBaseUrl::parse(&https).expect("HTTPS endpoint");
        assert_eq!(normalized.normalized, "https://cloud.example.test/api");
        assert_eq!(
            normalized.api_url(CloudRoute::Login).as_str(),
            "https://cloud.example.test/api/v1/auth/sessions"
        );

        assert!(ValidatedCloudBaseUrl::parse(&endpoint("http://127.0.0.1:55439", false)).is_err());
        assert!(ValidatedCloudBaseUrl::parse(&endpoint("http://127.0.0.1:55439", true)).is_ok());
        assert!(
            ValidatedCloudBaseUrl::parse(&endpoint("http://cloud-api.localhost:55439", true))
                .is_ok()
        );
    }

    #[test]
    fn cloud_base_url_policy_rejects_credentials_queries_fragments_and_ambiguity() {
        for value in [
            "http://cloud.example.test",
            "https://user:secret@cloud.example.test",
            "https://cloud.example.test?token=secret",
            "https://cloud.example.test#fragment",
            "https://cloud.example.test/%2e%2e/admin",
            "https://cloud.example.test/../admin",
            " https://cloud.example.test",
            "https://10.0.0.1",
            "https://169.254.169.254",
            "https://[fc00::1]",
        ] {
            assert!(
                ValidatedCloudBaseUrl::parse(&endpoint(value, false)).is_err(),
                "{value} should be rejected"
            );
        }
    }

    #[test]
    fn login_input_rejects_webview_authorization_fields() {
        let result = serde_json::from_value::<CloudLoginInput>(json!({
            "endpoint": {
                "baseUrl": "https://cloud.example.test",
                "allowInsecureLoopback": false
            },
            "email": "author@example.test",
            "password": "correct-horse-battery-staple",
            "device": {
                "deviceId": DEVICE_ID,
                "displayName": "Writer"
            },
            "authorization": format!("Bearer {ACCESS_CANARY}")
        }));
        assert!(result.is_err());
    }

    #[test]
    fn relay_allows_only_published_non_token_routes_with_matching_authentication() {
        let project_id = "019f9f4a-b3c7-7350-9226-000000000120";
        let team_id = "019f9f4a-b3c7-7350-9226-000000000121";
        let membership_id = "019f9f4a-b3c7-7350-9226-000000000122";
        let invitation_id = "019f9f4a-b3c7-7350-9226-000000000123";
        let marketplace_artifact_id = "019f9f4a-b3c7-7350-9226-000000000124";
        let marketplace_version_id = "019f9f4a-b3c7-7350-9226-000000000125";
        let allowed = [
            (
                CloudRelayMethod::Post,
                "/v1/identity/registrations".to_owned(),
                CloudRelayAuthentication::None,
            ),
            (
                CloudRelayMethod::Post,
                "/v1/identity/password-resets".to_owned(),
                CloudRelayAuthentication::None,
            ),
            (
                CloudRelayMethod::Post,
                "/v1/identity/password-resets/confirmations".to_owned(),
                CloudRelayAuthentication::None,
            ),
            (
                CloudRelayMethod::Get,
                "/v1/auth/sessions?limit=10".to_owned(),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Delete,
                format!("/v1/auth/sessions/{SESSION_ID}"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                "/v1/devices".to_owned(),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                "/v1/devices".to_owned(),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                "/v1/teams".to_owned(),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                "/v1/teams?limit=100".to_owned(),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                "/v1/marketplace/artifacts?kind=story_template&limit=100".to_owned(),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                "/v1/marketplace/artifacts/submissions".to_owned(),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/marketplace/artifacts/{marketplace_artifact_id}/downloads"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                format!(
                    "/v1/marketplace/artifacts/{marketplace_artifact_id}/versions/{marketplace_version_id}/reports"
                ),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/teams/{team_id}/members?limit=100"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/teams/{team_id}/invitations"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/team-invitations/{invitation_id}/acceptances"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/teams/{team_id}/members/{membership_id}/role-changes"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/teams/{team_id}/members/{membership_id}/revocations"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/teams/{team_id}/projects/{project_id}/assignments?limit=100"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Put,
                format!("/v1/teams/{team_id}/projects/{project_id}/assignments/{membership_id}"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/teams/{team_id}/projects/{project_id}/keys/3/recipients"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/teams/{team_id}/projects/{project_id}/keys/3/envelopes"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Delete,
                format!("/v1/devices/{DEVICE_ID}"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Put,
                format!("/v1/projects/{project_id}/keys/1"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/projects/{project_id}/keys/1"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/projects/{project_id}/keys/current"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/projects/{project_id}"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/projects/{project_id}/deletion-request"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/projects/{project_id}/deletion-cancellations"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/projects/{project_id}/sync/push"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/projects/{project_id}/sync/pull"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/projects/{project_id}/sync/snapshot"),
                CloudRelayAuthentication::Session,
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/projects/{project_id}/sync/tombstone-acknowledgements"),
                CloudRelayAuthentication::Session,
            ),
        ];
        for (method, path, authentication) in allowed {
            let policy = validate_relay_route(method, &path)
                .unwrap_or_else(|_| panic!("{method:?} {path} should be allowed"));
            assert_eq!(policy.authentication, authentication);
        }

        let pull = format!("/v1/projects/{project_id}/sync/pull?limit=256&cursor=abc_DEF-123");
        assert!(validate_relay_route(CloudRelayMethod::Get, &pull).is_ok());
        assert!(validate_relay_route(
            CloudRelayMethod::Get,
            &format!("/v1/projects/{project_id}/sync/pull?limit=257")
        )
        .is_err());

        let state = format!("/v1/projects/{project_id}?cursor=abc_DEF-123");
        assert!(validate_relay_route(CloudRelayMethod::Get, &state).is_ok());
        for query in [
            "limit=1",
            "cursor=",
            "cursor=first&cursor=second",
            "cursor=valid&unknown=value",
        ] {
            assert!(
                validate_relay_route(
                    CloudRelayMethod::Get,
                    &format!("/v1/projects/{project_id}?{query}")
                )
                .is_err(),
                "project-state query {query} must be rejected"
            );
        }

        let snapshot =
            format!("/v1/projects/{project_id}/sync/snapshot?limit=256&cursor=abc_DEF-123");
        assert!(validate_relay_route(CloudRelayMethod::Get, &snapshot).is_ok());
        for query in [
            "limit=0",
            "limit=257",
            "limit=1&limit=2",
            "cursor=valid&unknown=value",
        ] {
            assert!(
                validate_relay_route(
                    CloudRelayMethod::Get,
                    &format!("/v1/projects/{project_id}/sync/snapshot?{query}")
                )
                .is_err(),
                "sync-snapshot query {query} must be rejected"
            );
        }

        for (method, path) in [
            (
                CloudRelayMethod::Put,
                format!("/v1/projects/{project_id}/keys/current"),
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/projects/{project_id}/keys/current/"),
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/projects/{project_id}/keys/currently"),
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/projects/{project_id}/unknown"),
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/projects/{project_id}/sync/snapshot/extra"),
            ),
        ] {
            assert!(
                validate_relay_route(method, &path).is_err(),
                "{method:?} {path} must be rejected"
            );
        }

        for path in [
            "/v1/marketplace/artifacts?kind=unknown".to_owned(),
            "/v1/marketplace/artifacts?limit=101".to_owned(),
            "/v1/marketplace/moderation/queue".to_owned(),
            format!(
                "/v1/marketplace/artifacts/{marketplace_artifact_id}/versions/{marketplace_version_id}/moderation"
            ),
            "/v1/marketplace/artifacts/not-a-uuid/downloads".to_owned(),
        ] {
            assert!(
                validate_relay_route(CloudRelayMethod::Get, &path).is_err()
                    && validate_relay_route(CloudRelayMethod::Post, &path).is_err(),
                "{path} must be rejected"
            );
        }

        for (method, path) in [
            (CloudRelayMethod::Post, "/v1/auth/sessions".to_owned()),
            (
                CloudRelayMethod::Post,
                "/v1/identity/verifications".to_owned(),
            ),
            (
                CloudRelayMethod::Post,
                "/v1/auth/session-rotations".to_owned(),
            ),
            (
                CloudRelayMethod::Post,
                "/v1/auth/session-revocations".to_owned(),
            ),
            (
                CloudRelayMethod::Post,
                "/v1/account/deletion-requests".to_owned(),
            ),
            (
                CloudRelayMethod::Post,
                "/v1/account/deletion-request-lookups".to_owned(),
            ),
            (
                CloudRelayMethod::Post,
                "/v1/account/deletion-cancellations".to_owned(),
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/projects/{project_id}/deletion-requests"),
            ),
        ] {
            assert!(
                validate_relay_route(method, &path).is_err(),
                "{path} must use a dedicated native command"
            );
        }
    }

    #[test]
    fn relay_team_routes_enforce_method_query_body_and_identifier_policy() {
        let team_id = "019f9f4a-b3c7-7350-9226-000000000121";
        let project_id = "019f9f4a-b3c7-7350-9226-000000000120";
        let membership_id = "019f9f4a-b3c7-7350-9226-000000000122";

        for path in [
            "/v1/teams?limit=1025".to_owned(),
            format!("/v1/teams/{team_id}/members?unknown=value"),
            "/v1/teams/not-a-uuid/members".to_owned(),
            format!("/v1/teams/{team_id}/members/{membership_id}/role-changes/extra"),
            format!("/v1/teams/{team_id}/projects/{project_id}/assignments/not-a-uuid"),
        ] {
            assert!(
                validate_relay_route(CloudRelayMethod::Get, &path).is_err(),
                "{path} must be rejected"
            );
        }

        let mutation_path = format!("/v1/teams/{team_id}/members/{membership_id}/role-changes");
        let mutation_policy = validate_relay_route(CloudRelayMethod::Post, &mutation_path)
            .expect("published role-change route");
        assert!(mutation_policy.requires_body);
        assert!(mutation_policy.requires_idempotency_key);
        assert!(validate_relay_body(&json!({}), mutation_policy.requires_body).is_ok());

        let read_policy = validate_relay_route(
            CloudRelayMethod::Get,
            &format!("/v1/teams/{team_id}/members"),
        )
        .expect("published team-member list route");
        assert!(!read_policy.requires_body);
        assert!(!read_policy.requires_idempotency_key);
        assert!(validate_relay_body(&Value::Null, read_policy.requires_body).is_ok());
        assert!(validate_relay_body(&json!({}), read_policy.requires_body).is_err());

        assert!(!contains_forbidden_credential_field(&json!({
            "invitationToken": "one-time-invitation-capability"
        })));

        let recipient_path = format!("/v1/teams/{team_id}/projects/{project_id}/keys/3/recipients");
        let recipient_policy = validate_relay_route(CloudRelayMethod::Get, &recipient_path)
            .expect("published team-project recipient route");
        assert!(!recipient_policy.requires_body);
        assert!(!recipient_policy.requires_idempotency_key);

        let publish_path = format!("/v1/teams/{team_id}/projects/{project_id}/keys/3/envelopes");
        let publish_policy = validate_relay_route(CloudRelayMethod::Post, &publish_path)
            .expect("published team-project envelope route");
        assert!(publish_policy.requires_body);
        assert!(publish_policy.requires_idempotency_key);

        let current_key_path = format!("/v1/teams/{team_id}/projects/{project_id}/keys/current");
        let current_key_policy = validate_relay_route(CloudRelayMethod::Get, &current_key_path)
            .expect("ciphertext-free current-key metadata route");
        assert!(!current_key_policy.requires_body);
        assert!(!current_key_policy.requires_idempotency_key);
        validate_current_team_project_key_metadata_path(&current_key_path)
            .expect("exact current-key metadata path");

        let current_device_path =
            format!("/v1/teams/{team_id}/projects/{project_id}/keys/3/envelopes/current-device");
        assert!(
            validate_relay_route(CloudRelayMethod::Get, &current_device_path).is_err(),
            "the generic WebView relay must never return team envelope ciphertext"
        );
        validate_native_only_current_device_team_project_key_envelope_path(&current_device_path)
            .expect("native-only current-device team-project envelope route");

        for (method, path) in [
            (
                CloudRelayMethod::Get,
                format!("/v1/teams/{team_id}/projects/{project_id}/keys/03/recipients"),
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/teams/{team_id}/projects/{project_id}/keys/3/recipients?limit=1"),
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/teams/{team_id}/projects/{project_id}/keys/3/recipients"),
            ),
            (
                CloudRelayMethod::Post,
                format!("/v1/teams/{team_id}/projects/{project_id}/keys/current"),
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/teams/{team_id}/projects/{project_id}/keys/current?limit=1"),
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/teams/{team_id}/projects/{project_id}/keys/current/"),
            ),
            (
                CloudRelayMethod::Get,
                format!("/v1/teams/{team_id}/projects/{project_id}/keys/3/envelopes"),
            ),
            (
                CloudRelayMethod::Post,
                format!(
                    "/v1/teams/{team_id}/projects/{project_id}/keys/3/envelopes/current-device"
                ),
            ),
            (
                CloudRelayMethod::Get,
                format!(
                    "/v1/teams/{team_id}/projects/{project_id}/keys/3/envelopes/current-device/"
                ),
            ),
        ] {
            assert!(
                validate_relay_route(method, &path).is_err(),
                "{method:?} {path} must be rejected"
            );
        }
    }

    #[test]
    fn current_team_project_key_metadata_is_strict_and_toctou_safe() {
        let team_id = "019f9f4a-b3c7-7350-9226-000000000121";
        let project_id = "019f9f4a-b3c7-7350-9226-000000000120";
        let current = CloudTeamProjectCurrentKeyResponse {
            schema_version: CLOUD_SCHEMA_VERSION,
            request_id: REQUEST_ID.to_owned(),
            team_id: team_id.to_owned(),
            project_id: project_id.to_owned(),
            key_version: 3,
            state: "active".to_owned(),
            server_revision: 17,
            updated_at: "2026-07-28T02:00:00.000Z".to_owned(),
            current_device_envelope_available: true,
        };
        validate_current_team_project_key_metadata(&current, REQUEST_ID, team_id, project_id)
            .expect("valid ciphertext-free authority metadata");

        let unknown_ciphertext = json!({
            "schemaVersion": 1,
            "requestId": REQUEST_ID,
            "teamId": team_id,
            "projectId": project_id,
            "keyVersion": 3,
            "state": "active",
            "serverRevision": 17,
            "updatedAt": "2026-07-28T02:00:00.000Z",
            "currentDeviceEnvelopeAvailable": true,
            "ciphertext": "must-not-be-admitted"
        });
        assert!(
            serde_json::from_value::<CloudTeamProjectCurrentKeyResponse>(unknown_ciphertext)
                .is_err(),
            "authority metadata must reject cryptogram fields"
        );

        let mut confirmed = current.clone();
        confirmed.request_id = NEXT_SESSION_ID.to_owned();
        ensure_current_team_project_key_metadata_unchanged(&current, &confirmed, NEXT_SESSION_ID)
            .expect("a second identical authority snapshot is stable");

        for drift in ["keyVersion", "serverRevision", "updatedAt"] {
            let mut changed = confirmed.clone();
            match drift {
                "keyVersion" => changed.key_version += 1,
                "serverRevision" => changed.server_revision += 1,
                "updatedAt" => changed.updated_at = "2026-07-28T02:00:01.000Z".to_owned(),
                _ => unreachable!(),
            }
            let error = ensure_current_team_project_key_metadata_unchanged(
                &current,
                &changed,
                NEXT_SESSION_ID,
            )
            .expect_err("authority drift must fail closed");
            assert_eq!(error.code(), "REVISION_CONFLICT", "{drift} drift");
            assert!(error.retryable(), "{drift} drift should require retry");
        }

        let unavailable =
            current_device_team_project_key_envelope_unavailable(current.request_id.as_str());
        assert_eq!(unavailable.code(), "RESOURCE_NOT_FOUND");
        assert!(!unavailable.retryable());
        let unavailable_wire =
            serde_json::to_string(&unavailable).expect("stable unavailable error should serialize");
        assert!(!unavailable_wire.contains(team_id));
        assert!(!unavailable_wire.contains(project_id));
        assert!(!unavailable_wire.contains("envelope"));
    }

    #[test]
    fn current_device_team_key_verification_input_has_no_version_or_cryptogram_channel() {
        let team_id = "019f9f4a-b3c7-7350-9226-000000000121";
        let project_id = "019f9f4a-b3c7-7350-9226-000000000120";
        let input = json!({
            "teamId": team_id,
            "projectId": project_id,
            "expectedSessionId": SESSION_ID,
            "expectedAccountId": ACCOUNT_ID,
            "expectedDeviceId": DEVICE_ID,
            "expectedRecipientPublicKey": "native-bound-public-key",
            "expectedRecipientPublicKeyFingerprint": "native-bound-fingerprint"
        });
        serde_json::from_value::<AcceptCurrentDeviceTeamProjectKeyEnvelopeInput>(input.clone())
            .expect("scope and native identity are the complete IPC input");

        for forbidden_field in ["keyVersion", "ciphertext", "encapsulatedKey", "privateKey"] {
            let mut forbidden = input.clone();
            forbidden
                .as_object_mut()
                .expect("object")
                .insert(forbidden_field.to_owned(), json!("must-not-cross-ipc"));
            assert!(
                serde_json::from_value::<AcceptCurrentDeviceTeamProjectKeyEnvelopeInput>(forbidden)
                    .is_err(),
                "{forbidden_field} must not be admitted by the native command"
            );
        }
    }

    #[test]
    fn relay_project_read_routes_reject_bodies_and_idempotency_keys() {
        let project_id = "019f9f4a-b3c7-7350-9226-000000000120";
        let mut headers = BTreeMap::new();
        headers.insert("X-Request-Id".to_owned(), REQUEST_ID.to_owned());
        headers.insert(
            "Idempotency-Key".to_owned(),
            "project-read-must-not-be-idempotent".to_owned(),
        );

        for path in [
            format!("/v1/projects/{project_id}"),
            format!("/v1/projects/{project_id}/deletion-request"),
            format!("/v1/projects/{project_id}/sync/snapshot"),
        ] {
            let policy =
                validate_relay_route(CloudRelayMethod::Get, &path).expect("project read route");
            assert!(!policy.requires_body);
            assert!(!policy.requires_idempotency_key);
            assert!(validate_relay_body(&Value::Null, policy.requires_body).is_ok());
            assert!(validate_relay_body(&json!({}), policy.requires_body).is_err());
            assert!(
                validate_relay_headers(&headers, policy.requires_idempotency_key).is_err(),
                "{path} must reject Idempotency-Key"
            );
        }
    }

    #[test]
    fn relay_rejects_authorization_and_token_fields_from_webview() {
        let parsed: SendCloudApiRequestInput = serde_json::from_value(json!({
            "baseUrl": "https://cloud.example.test",
            "method": "GET",
            "path": "/v1/devices",
            "headers": { "X-Request-Id": REQUEST_ID },
            "body": null,
            "authentication": "session"
        }))
        .expect("documented relay wire format parses");
        assert_eq!(parsed.method, CloudRelayMethod::Get);
        assert_eq!(parsed.authentication, CloudRelayAuthentication::Session);

        let mut headers = BTreeMap::new();
        headers.insert("X-Request-Id".to_owned(), REQUEST_ID.to_owned());
        headers.insert(
            "Authorization".to_owned(),
            format!("Bearer {ACCESS_CANARY}"),
        );
        let error = validate_relay_headers(&headers, false).expect_err("authorization must fail");
        assert_eq!(error.code(), "CLOUD_AUTHORIZATION_INPUT_FORBIDDEN");

        assert!(contains_forbidden_credential_field(&json!({
            "refreshToken": REFRESH_CANARY
        })));
        assert!(contains_forbidden_credential_field(&json!({
            "nested": { "access_token": ACCESS_CANARY }
        })));
        assert!(contains_forbidden_credential_field(&json!({
            "password": "correct-horse-battery-staple"
        })));
        assert!(!contains_forbidden_credential_field(&json!({
            "ciphertext": "opaque"
        })));
    }

    #[test]
    fn deletion_credential_command_input_is_strict_and_validates_secret_metadata() {
        let project_id = "019f9f4a-b3c7-7350-9226-000000000120";
        let confirmation_id = "019f9f4a-b3c7-7350-9226-000000000121";
        let parsed: CloudDeletionCredentialInput = serde_json::from_value(json!({
            "operation": "request_project",
            "baseUrl": "https://cloud.example.test",
            "allowInsecureLoopback": false,
            "projectId": project_id,
            "requestId": REQUEST_ID,
            "idempotencyKey": "deletion-idempotency-key-0001",
            "expectedRevision": 3,
            "confirmationId": confirmation_id,
            "password": "correct-horse-battery-staple"
        }))
        .expect("dedicated project deletion input");
        match &parsed {
            CloudDeletionCredentialInput::RequestProject {
                request_id,
                idempotency_key,
                expected_revision,
                confirmation_id,
                password,
                ..
            } => {
                validate_deletion_credential_common(
                    request_id,
                    Some(idempotency_key),
                    *expected_revision,
                    password,
                )
                .expect("credential metadata");
                validate_uuid_v7(confirmation_id).expect("confirmation id");
            }
            _ => panic!("unexpected deletion credential operation"),
        }

        let account_request: CloudDeletionCredentialInput = serde_json::from_value(json!({
            "operation": "request_account",
            "baseUrl": "https://cloud.example.test",
            "requestId": REQUEST_ID,
            "idempotencyKey": "deletion-idempotency-key-0002",
            "expectedRevision": 4,
            "confirmationId": confirmation_id,
            "email": "Writer@Example.COM",
            "password": "correct-horse-battery-staple"
        }))
        .expect("dedicated account deletion input");
        match &account_request {
            CloudDeletionCredentialInput::RequestAccount { email, .. } => {
                assert_eq!(
                    normalize_email(email).expect("canonical account email"),
                    "writer@example.com"
                );
            }
            _ => panic!("unexpected account deletion operation"),
        }

        for lookup in [
            json!({
                "operation": "lookup_account",
                "baseUrl": "https://cloud.example.test",
                "requestId": REQUEST_ID,
                "deletionRequestId": project_id,
                "email": "writer@example.com",
                "password": "correct-horse-battery-staple"
            }),
            json!({
                "operation": "lookup_account",
                "baseUrl": "https://cloud.example.test",
                "requestId": REQUEST_ID,
                "confirmationId": confirmation_id,
                "email": "writer@example.com",
                "password": "correct-horse-battery-staple"
            }),
        ] {
            let parsed_lookup: CloudDeletionCredentialInput =
                serde_json::from_value(lookup).expect("strict account deletion lookup input");
            match &parsed_lookup {
                CloudDeletionCredentialInput::LookupAccount {
                    deletion_request_id,
                    confirmation_id,
                    ..
                } => {
                    validate_deletion_lookup_proof(
                        deletion_request_id.as_deref(),
                        confirmation_id.as_deref(),
                    )
                    .expect("exactly one lookup proof");
                }
                _ => panic!("unexpected account deletion lookup operation"),
            }
        }

        for invalid in [
            json!({
                "operation": "request_project",
                "baseUrl": "https://cloud.example.test",
                "projectId": project_id,
                "requestId": REQUEST_ID,
                "idempotencyKey": "deletion-idempotency-key-0001",
                "expectedRevision": 3,
                "confirmationId": confirmation_id,
                "password": "correct-horse-battery-staple",
                "authorization": format!("Bearer {ACCESS_CANARY}")
            }),
            json!({
                "operation": "unknown",
                "baseUrl": "https://cloud.example.test",
                "requestId": REQUEST_ID,
                "password": "correct-horse-battery-staple"
            }),
        ] {
            assert!(serde_json::from_value::<CloudDeletionCredentialInput>(invalid).is_err());
        }
        assert!(validate_deletion_lookup_proof(Some(project_id), Some(confirmation_id)).is_err());
        assert!(validate_deletion_lookup_proof(None, None).is_err());
        assert!(validate_deletion_credential_common(
            REQUEST_ID,
            Some("deletion-idempotency-key-0001"),
            0,
            "correct-horse-battery-staple"
        )
        .is_err());
        assert!(validate_password("correct-horse\nbattery-staple").is_err());
        assert!(validate_password(&"🔐".repeat(128)).is_ok());
        assert!(validate_password(&"🔐".repeat(129)).is_err());
    }

    #[test]
    fn relay_response_sanitizer_rejects_session_token_canaries_under_any_key() {
        let expected = expected_device();
        let grant: CloudSessionGrantResponse =
            serde_json::from_value(valid_grant_json(&expected, SESSION_ID)).expect("grant parses");
        let endpoint = ValidatedCloudBaseUrl::parse(&endpoint("https://cloud.example.test", false))
            .expect("endpoint");
        let stored = stored_session_from_grant(grant, &endpoint, 1);
        assert!(response_contains_session_token(
            &json!({ "opaque": ACCESS_CANARY }),
            Some(&stored)
        ));
        assert!(response_contains_session_token(
            &json!({ "nested": [REFRESH_CANARY] }),
            Some(&stored)
        ));
        assert!(!response_contains_session_token(
            &json!({ "ciphertext": "not-a-session-token" }),
            Some(&stored)
        ));
        assert!(response_contains_sensitive_value(
            &json!({ "message": "Rejected correct-horse-battery-staple" }),
            "correct-horse-battery-staple"
        ));
        assert!(response_contains_sensitive_value(
            &json!({ "correct-horse-battery-staple": "reflected in a key" }),
            "correct-horse-battery-staple"
        ));
        assert!(!response_contains_sensitive_value(
            &json!({ "message": "The credentials could not be verified." }),
            "correct-horse-battery-staple"
        ));
        let headers = BTreeMap::from([(
            "retry-after".to_owned(),
            "correct-horse-battery-staple".to_owned(),
        )]);
        assert!(response_headers_contain_sensitive_value(
            &headers,
            "correct-horse-battery-staple"
        ));
    }

    #[test]
    fn strict_grant_protocol_sanitizes_token_canaries_from_ipc_status() {
        let expected = expected_device();
        let body = valid_grant_json(&expected, SESSION_ID);
        let grant: CloudSessionGrantResponse =
            serde_json::from_value(body).expect("strict grant parses");
        validate_session_grant(&grant, REQUEST_ID, &expected, None).expect("grant validates");
        let endpoint = ValidatedCloudBaseUrl::parse(&endpoint("https://cloud.example.test", false))
            .expect("endpoint");
        let record = stored_session_from_grant(grant, &endpoint, 1);
        let encoded = encode_stored_session(&record).expect("session encodes");
        assert!(encoded.contains(ACCESS_CANARY));
        assert!(encoded.contains(REFRESH_CANARY));

        let status_json =
            serde_json::to_string(&status_from_record(&record)).expect("status serializes");
        assert!(!status_json.contains(ACCESS_CANARY));
        assert!(!status_json.contains(REFRESH_CANARY));
        assert!(!status_json.contains("accessToken"));
        assert!(!status_json.contains("refreshToken"));
        assert!(status_json.contains(SESSION_ID));
    }

    #[test]
    fn strict_grant_protocol_rejects_unknown_fields_and_identity_mismatch() {
        let expected = expected_device();
        let mut unknown = valid_grant_json(&expected, SESSION_ID);
        unknown
            .as_object_mut()
            .expect("object")
            .insert("unexpected".to_owned(), Value::Bool(true));
        assert!(serde_json::from_value::<CloudSessionGrantResponse>(unknown).is_err());

        let mut mismatch = valid_grant_json(&expected, SESSION_ID);
        mismatch["session"]["deviceId"] =
            Value::String("019f9f4a-b3c7-7350-9226-000000000199".to_owned());
        let mismatch: CloudSessionGrantResponse =
            serde_json::from_value(mismatch).expect("shape parses");
        assert!(validate_session_grant(&mismatch, REQUEST_ID, &expected, None).is_err());
    }

    #[test]
    fn stored_session_round_trip_is_endpoint_bound_and_strict() {
        let expected = expected_device();
        let grant: CloudSessionGrantResponse =
            serde_json::from_value(valid_grant_json(&expected, SESSION_ID)).expect("grant parses");
        let endpoint =
            ValidatedCloudBaseUrl::parse(&endpoint("https://cloud.example.test/api", false))
                .expect("endpoint");
        let record = stored_session_from_grant(grant, &endpoint, 7);
        let encoded = encode_stored_session(&record).expect("session encodes");
        let decoded = decode_stored_session(encoded.as_str()).expect("session decodes");
        assert_eq!(decoded.base_url, "https://cloud.example.test/api");
        assert_eq!(decoded.record_generation, 7);

        let tampered = encoded.replace(
            "https://cloud.example.test/api",
            "http://cloud.example.test/api",
        );
        assert!(decode_stored_session(&tampered).is_err());
    }

    #[test]
    fn compare_and_swap_rejects_stale_session_or_generation() {
        let current = VaultVersion {
            session_id: SESSION_ID.to_owned(),
            record_generation: 3,
        };
        assert!(ensure_compare_and_swap(Some(current.clone()), Some(&current)).is_ok());
        assert!(ensure_compare_and_swap(None, None).is_ok());
        assert!(ensure_compare_and_swap(Some(current.clone()), None).is_err());
        assert!(ensure_compare_and_swap(None, Some(&current)).is_err());
        assert!(ensure_compare_and_swap(
            Some(VaultVersion {
                session_id: NEXT_SESSION_ID.to_owned(),
                record_generation: 4,
            }),
            Some(&current),
        )
        .is_err());
        assert!(ensure_compare_and_swap(
            Some(VaultVersion {
                session_id: SESSION_ID.to_owned(),
                record_generation: 4,
            }),
            Some(&current),
        )
        .is_err());
    }

    #[test]
    fn timestamps_validate_calendar_and_monotonic_order() {
        assert!(parse_iso_utc_timestamp("2026-02-29T00:00:00.000Z").is_err());
        assert!(parse_iso_utc_timestamp("2028-02-29T00:00:00.000Z").is_ok());
        assert!(
            parse_iso_utc_timestamp("2026-07-27T01:00:00.000Z").expect("timestamp")
                < parse_iso_utc_timestamp("2026-07-27T01:00:00.001Z").expect("timestamp")
        );
    }

    #[test]
    fn stored_team_receipt_opening_uses_local_account_device_binding_not_token_freshness() {
        let expected = expected_device();
        let grant: CloudSessionGrantResponse =
            serde_json::from_value(valid_grant_json(&expected, SESSION_ID))
                .expect("valid stored-session fixture");
        let endpoint = ValidatedCloudBaseUrl::parse(&CloudEndpointInput {
            base_url: "https://cloud.inkshadow.test".to_owned(),
            allow_insecure_loopback: false,
        })
        .expect("endpoint");
        let stored = stored_session_from_grant(grant, &endpoint, 1);
        // The fixture access/session expiry is 2026-07-27. Receipt opening
        // deliberately does not compare those timestamps with a live clock.
        let mut input = team_receipt_access_input(Some(SESSION_ID), &expected);
        assert!(
            resolve_team_project_key_receipt_local_authority(Some(&stored), &input, true)
                .expect("an expired but locally bound session remains offline authority")
                .is_some()
        );

        input.expected_session_id = None;
        assert!(
            resolve_team_project_key_receipt_local_authority(None, &input, true)
                .expect("explicitly signed-out local mode")
                .is_none()
        );

        input.expected_session_id = Some(SESSION_ID.to_owned());
        assert!(resolve_team_project_key_receipt_local_authority(None, &input, true).is_err());
        input.expected_session_id = None;
        assert!(resolve_team_project_key_receipt_local_authority(None, &input, false).is_err());

        let mut cross_account = team_receipt_access_input(Some(SESSION_ID), &expected);
        cross_account.receipt.account_id = "019f9f4a-b3c7-7350-9226-000000000199".to_owned();
        assert!(resolve_team_project_key_receipt_local_authority(
            Some(&stored),
            &cross_account,
            true
        )
        .is_err());
    }

    fn endpoint(base_url: &str, allow_insecure_loopback: bool) -> CloudEndpointInput {
        CloudEndpointInput {
            base_url: base_url.to_owned(),
            allow_insecure_loopback,
        }
    }

    fn expected_device() -> ExpectedDeviceIdentity {
        let mut rng = StdRng::seed_from_u64(7);
        let (_, public_key) = DeviceKem::gen_keypair(&mut rng);
        let bytes = public_key.to_bytes();
        ExpectedDeviceIdentity {
            device_id: DEVICE_ID.to_owned(),
            display_name: "Writer".to_owned(),
            algorithm: DEVICE_KEY_ALGORITHM.to_owned(),
            public_key: URL_SAFE_NO_PAD.encode(bytes),
            public_key_fingerprint: sha256_hex(bytes.as_ref()),
            client_version: env!("CARGO_PKG_VERSION").to_owned(),
        }
    }

    fn team_receipt_access_input(
        expected_session_id: Option<&str>,
        expected: &ExpectedDeviceIdentity,
    ) -> TeamProjectKeyReceiptAccessInput {
        TeamProjectKeyReceiptAccessInput {
            expected_session_id: expected_session_id.map(str::to_owned),
            receipt: TeamProjectKeyReceiptBinding {
                schema_version: 1,
                receipt_kind: "team_managed_device_envelope".to_owned(),
                team_id: "019f9f4a-b3c7-7350-9226-000000000121".to_owned(),
                project_id: "019f9f4a-b3c7-7350-9226-000000000122".to_owned(),
                key_version: 1,
                account_id: ACCOUNT_ID.to_owned(),
                device_id: expected.device_id.clone(),
                envelope_id: "019f9f4a-b3c7-7350-9226-000000000123".to_owned(),
                membership_id: "019f9f4a-b3c7-7350-9226-000000000124".to_owned(),
                membership_revision: 1,
                assignment_id: "019f9f4a-b3c7-7350-9226-000000000125".to_owned(),
                assignment_revision: 1,
                sender_device_id: "019f9f4a-b3c7-7350-9226-000000000126".to_owned(),
                sender_public_key_fingerprint: "a".repeat(64),
                recipient_public_key_fingerprint: expected.public_key_fingerprint.clone(),
                project_key_fingerprint: "b".repeat(64),
                native_storage_ref: format!("team_project_key_receipt_v1_{}", "c".repeat(64)),
                native_receipt_fingerprint: "d".repeat(64),
                current_server_revision: 1,
                current_key_updated_at: "2026-07-27T00:00:00.000Z".to_owned(),
                envelope_created_at: "2026-07-27T00:00:00.000Z".to_owned(),
            },
        }
    }

    fn valid_grant_json(expected: &ExpectedDeviceIdentity, session_id: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "requestId": REQUEST_ID,
            "account": {
                "schemaVersion": 1,
                "accountId": ACCOUNT_ID,
                "state": "active",
                "revision": 1,
                "verifiedAt": "2026-07-27T00:00:00.000Z",
                "deletionScheduledFor": null,
                "createdAt": "2026-07-27T00:00:00.000Z",
                "updatedAt": "2026-07-27T00:00:00.000Z"
            },
            "device": {
                "schemaVersion": 1,
                "device": {
                    "schemaVersion": 1,
                    "deviceId": expected.device_id,
                    "accountId": ACCOUNT_ID,
                    "state": "trusted",
                    "publicKeyFingerprint": expected.public_key_fingerprint,
                    "createdAt": "2026-07-27T00:00:00.000Z",
                    "revokedAt": null
                },
                "publicKey": {
                    "schemaVersion": 1,
                    "deviceId": expected.device_id,
                    "accountId": ACCOUNT_ID,
                    "algorithm": expected.algorithm,
                    "publicKey": expected.public_key,
                    "publicKeyFingerprint": expected.public_key_fingerprint,
                    "createdAt": "2026-07-27T00:00:00.000Z",
                    "revokedAt": null
                },
                "displayName": expected.display_name,
                "revision": 1
            },
            "session": {
                "schemaVersion": 1,
                "sessionId": session_id,
                "accountId": ACCOUNT_ID,
                "deviceId": expected.device_id,
                "clientVersion": expected.client_version,
                "minimumClientVersion": "0.1.0",
                "issuedAt": "2026-07-27T00:00:00.000Z",
                "expiresAt": "2026-07-27T01:00:00.000Z",
                "revokedAt": null
            },
            "tokens": {
                "accessToken": ACCESS_CANARY,
                "accessTokenExpiresAt": "2026-07-27T01:00:00.000Z",
                "refreshToken": REFRESH_CANARY,
                "refreshTokenExpiresAt": "2026-08-26T00:00:00.000Z"
            }
        })
    }
}
