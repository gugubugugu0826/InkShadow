//! Fail-closed update manifest verification and inert package staging.
//!
//! This module deliberately does not execute a downloaded installer. A release
//! build must first pin an update-manifest key and URL. The staged package
//! remains extensionless until a separate platform-signature gate verifies the
//! Authenticode publisher in the release environment.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::StreamExt;
use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode, Url};
use ring::signature::{UnparsedPublicKey, ED25519};
use same_file::Handle;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::model_gateway::CommandError;
use crate::network_egress::{host_is_ip_literal, literal_ip_is_allowed, RestrictedDnsResolver};

const PRODUCT_ID: &str = "com.inkshadow.desktop";
const MANIFEST_SCHEMA_VERSION: u8 = 1;
const CHECKPOINT_SCHEMA_VERSION: u8 = 1;
const CHECKPOINT_CREDENTIAL_SERVICE: &str = "com.inkshadow.desktop";
const CHECKPOINT_CREDENTIAL_PREFIX: &str = "secure-update-checkpoint:v1";
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_CHECKPOINT_BYTES: usize = 4 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_STAGING_BYTES: u64 = MAX_ARTIFACT_BYTES;
const MAX_MANIFEST_LIFETIME_SECONDS: u64 = 31 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS: u64 = 5 * 60;
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_ROLLBACK_SOURCES: usize = 32;
const MAX_PINNED_KEYS: usize = 2;
const UPDATE_DIRECTORY: &str = "verified-update-staging";
const UPDATE_OPERATION_LOCK: &str = ".operation.lock";

#[derive(Default)]
pub(crate) struct SecureUpdaterState {
    operation: Mutex<()>,
    plans: Mutex<HashMap<String, VerifiedUpdatePlan>>,
}

#[derive(Clone)]
struct SecureUpdateConfiguration {
    channel: String,
    manifest_url: Url,
    public_keys: Vec<PinnedManifestKey>,
}

#[derive(Clone)]
struct PinnedManifestKey {
    id: String,
    public_key: [u8; 32],
}

#[derive(Clone, Debug)]
struct VerifiedUpdatePlan {
    id: String,
    state: UpdatePlanState,
    release_version: String,
    published_at: u64,
    expires_at: u64,
    manifest_sequence: u64,
    mandatory: bool,
    payload_sha256: String,
    security_floor_version: String,
    signing_key_id: String,
    artifact_url: Url,
    artifact_size_bytes: u64,
    artifact_sha256: String,
    artifact_sha256_bytes: [u8; 32],
    release_notes_url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum UpdatePlanState {
    UpToDate,
    UpdateAvailable,
    RollbackAvailable,
    ManualUpdateRequired,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecureUpdateConfigurationResponse {
    enabled: bool,
    current_version: &'static str,
    channel: &'static str,
    disabled_reason: Option<&'static str>,
    executes_installer: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignedUpdateCheckResponse {
    plan_id: Option<String>,
    state: UpdatePlanState,
    current_version: String,
    release_version: String,
    published_at: u64,
    expires_at: u64,
    manifest_sequence: u64,
    signing_key_id: String,
    mandatory: bool,
    artifact_size_bytes: u64,
    artifact_sha256: String,
    release_notes_url: Option<String>,
    installer_execution_allowed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StagedUpdateReceipt {
    plan_id: String,
    release_version: String,
    manifest_sequence: u64,
    signing_key_id: String,
    artifact_size_bytes: u64,
    artifact_sha256: String,
    package_state: &'static str,
    authenticode_status: &'static str,
    installation_allowed: bool,
    next_required_action: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateEnvelope {
    schema_version: u8,
    key_id: String,
    payload: String,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SignedUpdateManifest {
    schema_version: u8,
    product: String,
    channel: String,
    signing_key_id: String,
    manifest_sequence: u64,
    release_version: String,
    minimum_updater_version: String,
    security_floor_version: String,
    published_at: u64,
    expires_at: u64,
    artifact: SignedUpdateArtifact,
    rollback: SignedRollbackPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    release_notes_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SignedUpdateArtifact {
    target: String,
    kind: String,
    url: String,
    size_bytes: u64,
    sha256: String,
    authenticode_required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SignedRollbackPolicy {
    allowed_from: Vec<String>,
    requires_explicit_confirmation: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PersistedUpdateCheckpoint {
    schema_version: u8,
    product: String,
    channel: String,
    highest_manifest_sequence: u64,
    payload_sha256: String,
    security_floor_version: String,
    last_seen_time: u64,
}

struct StagingOperationLock {
    file: Option<std::fs::File>,
    path: PathBuf,
}

struct SecureStagingRoot {
    identity: Handle,
}

impl Drop for StagingOperationLock {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(windows)]
struct WindowsOwnedHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for WindowsOwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this wrapper owns the real token handle returned by
            // OpenProcessToken and closes it exactly once.
            let _ = unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
        }
    }
}

#[cfg(windows)]
struct LocalSecurityDescriptor(windows_sys::Win32::Security::PSECURITY_DESCRIPTOR);

#[cfg(windows)]
impl Drop for LocalSecurityDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: GetSecurityInfo allocates this descriptor with LocalAlloc
            // and transfers ownership to the caller.
            let _ = unsafe { windows_sys::Win32::Foundation::LocalFree(self.0) };
        }
    }
}

#[tauri::command]
pub(crate) fn inspect_secure_update_configuration() -> SecureUpdateConfigurationResponse {
    match configured_update_configuration() {
        Ok(configuration) => SecureUpdateConfigurationResponse {
            enabled: true,
            current_version: env!("CARGO_PKG_VERSION"),
            channel: leak_channel_label(&configuration.channel),
            disabled_reason: None,
            executes_installer: false,
        },
        Err(reason) => SecureUpdateConfigurationResponse {
            enabled: false,
            current_version: env!("CARGO_PKG_VERSION"),
            channel: leak_channel_label(compile_time_channel()),
            disabled_reason: Some(reason),
            executes_installer: false,
        },
    }
}

#[tauri::command]
pub(crate) async fn check_for_signed_update(
    state: State<'_, SecureUpdaterState>,
) -> Result<SignedUpdateCheckResponse, CommandError> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| update_operation_busy())?;
    state.plans.lock().await.clear();
    let configuration =
        configured_update_configuration().map_err(|_| update_configuration_missing())?;
    let envelope = fetch_manifest_envelope(&configuration).await?;
    let now = unix_time_now()?;
    let plan = verify_update_envelope(&envelope, &configuration, env!("CARGO_PKG_VERSION"), now)?;
    enforce_and_persist_checkpoint(&configuration, &plan, now).await?;
    let response = plan_response(&plan, env!("CARGO_PKG_VERSION"));

    let mut plans = state.plans.lock().await;
    if plan.state == UpdatePlanState::UpdateAvailable {
        plans.insert(plan.id.clone(), plan);
    }
    Ok(response)
}

#[tauri::command]
pub(crate) async fn stage_signed_update(
    app: AppHandle,
    state: State<'_, SecureUpdaterState>,
    plan_id: String,
) -> Result<StagedUpdateReceipt, CommandError> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| update_operation_busy())?;
    if !is_lower_hex_sha256(&plan_id) {
        return Err(update_plan_missing());
    }
    let plan = {
        let plans = state.plans.lock().await;
        plans
            .get(&plan_id)
            .cloned()
            .ok_or_else(update_plan_missing)?
    };

    if unix_time_now()? >= plan.expires_at {
        state.plans.lock().await.remove(&plan_id);
        return Err(update_manifest_expired());
    }
    if plan.state != UpdatePlanState::UpdateAvailable {
        return Err(update_plan_not_stageable());
    }

    let configuration =
        configured_update_configuration().map_err(|_| update_configuration_missing())?;
    enforce_and_persist_checkpoint(&configuration, &plan, unix_time_now()?).await?;
    if !same_origin(&configuration.manifest_url, &plan.artifact_url) {
        return Err(update_artifact_origin_invalid());
    }
    let staging_root = app
        .path()
        .app_data_dir()
        .map_err(|_| update_stage_failed())?
        .join(UPDATE_DIRECTORY);
    let staged_path = stage_verified_artifact(&plan, &staging_root).await?;

    // Do not expose the local path to the WebView. Keeping a non-executable
    // package also prevents this verification boundary from becoming an
    // accidental execution primitive.
    debug_assert_eq!(
        staged_path.extension().and_then(|value| value.to_str()),
        Some("pending")
    );
    Ok(StagedUpdateReceipt {
        plan_id: plan.id,
        release_version: plan.release_version,
        manifest_sequence: plan.manifest_sequence,
        signing_key_id: plan.signing_key_id,
        artifact_size_bytes: plan.artifact_size_bytes,
        artifact_sha256: plan.artifact_sha256,
        package_state: "digest_verified_inert_staging",
        authenticode_status: "not_verified",
        installation_allowed: false,
        next_required_action: "VERIFY_AUTHENTICODE_PUBLISHER_IN_RELEASE_PIPELINE",
    })
}

fn compile_time_channel() -> &'static str {
    option_env!("INKSHADOW_UPDATE_CHANNEL").unwrap_or("stable")
}

fn leak_channel_label(channel: &str) -> &'static str {
    match channel {
        "stable" => "stable",
        "beta" => "beta",
        _ => "invalid",
    }
}

fn configured_update_configuration() -> Result<SecureUpdateConfiguration, &'static str> {
    let channel = compile_time_channel();
    if !matches!(channel, "stable" | "beta") {
        return Err("UPDATE_CHANNEL_INVALID");
    }
    let manifest_url = option_env!("INKSHADOW_UPDATE_MANIFEST_URL")
        .ok_or("UPDATE_MANIFEST_URL_NOT_PINNED")
        .and_then(|value| {
            parse_https_url(value, None).map_err(|_| "UPDATE_MANIFEST_URL_INVALID")
        })?;
    let primary_key_id = option_env!("INKSHADOW_UPDATE_KEY_ID")
        .ok_or("UPDATE_KEY_ID_NOT_PINNED")
        .and_then(|value| {
            validate_key_id(value)
                .then(|| value.to_owned())
                .ok_or("UPDATE_KEY_ID_INVALID")
        })?;
    let primary_public_key = option_env!("INKSHADOW_UPDATE_PUBLIC_KEY_B64URL")
        .ok_or("UPDATE_PUBLIC_KEY_NOT_PINNED")
        .and_then(|value| {
            decode_fixed_base64url::<32>(value, "UPDATE_PUBLIC_KEY_INVALID")
                .map_err(|_| "UPDATE_PUBLIC_KEY_INVALID")
        })?;
    let mut public_keys = vec![PinnedManifestKey {
        id: primary_key_id,
        public_key: primary_public_key,
    }];
    match (
        option_env!("INKSHADOW_UPDATE_SECONDARY_KEY_ID"),
        option_env!("INKSHADOW_UPDATE_SECONDARY_PUBLIC_KEY_B64URL"),
    ) {
        (None, None) => {}
        (Some(id), Some(encoded_key)) => {
            if !validate_key_id(id) || public_keys.iter().any(|key| key.id == id) {
                return Err("UPDATE_SECONDARY_KEY_ID_INVALID");
            }
            let public_key =
                decode_fixed_base64url::<32>(encoded_key, "UPDATE_SECONDARY_PUBLIC_KEY_INVALID")
                    .map_err(|_| "UPDATE_SECONDARY_PUBLIC_KEY_INVALID")?;
            if public_keys.iter().any(|key| key.public_key == public_key) {
                return Err("UPDATE_SECONDARY_KEY_DUPLICATE");
            }
            public_keys.push(PinnedManifestKey {
                id: id.to_owned(),
                public_key,
            });
        }
        _ => return Err("UPDATE_SECONDARY_KEY_INCOMPLETE"),
    }
    if public_keys.is_empty() || public_keys.len() > MAX_PINNED_KEYS {
        return Err("UPDATE_KEYRING_INVALID");
    }
    Ok(SecureUpdateConfiguration {
        channel: channel.to_owned(),
        manifest_url,
        public_keys,
    })
}

async fn fetch_manifest_envelope(
    configuration: &SecureUpdateConfiguration,
) -> Result<String, CommandError> {
    let client = build_update_client(Duration::from_secs(30))?;
    let response = client
        .get(configuration.manifest_url.clone())
        .header("accept", "application/vnd.inkshadow.update-envelope+json")
        .send()
        .await
        .map_err(|_| update_fetch_failed())?;
    if response.status() != StatusCode::OK {
        return Err(update_http_status(response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MANIFEST_BYTES as u64)
    {
        return Err(update_manifest_too_large());
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| update_fetch_failed())?;
        if bytes.len().saturating_add(chunk.len()) > MAX_MANIFEST_BYTES {
            return Err(update_manifest_too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| update_manifest_invalid())
}

fn build_update_client(total_timeout: Duration) -> Result<Client, CommandError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(total_timeout)
        .redirect(Policy::none())
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .dns_resolver(RestrictedDnsResolver)
        .user_agent(concat!("InkShadow/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| update_configuration_invalid())
}

fn verify_update_envelope(
    envelope_json: &str,
    configuration: &SecureUpdateConfiguration,
    current_version: &str,
    now: u64,
) -> Result<VerifiedUpdatePlan, CommandError> {
    if envelope_json.len() > MAX_MANIFEST_BYTES {
        return Err(update_manifest_too_large());
    }
    let envelope: UpdateEnvelope =
        serde_json::from_str(envelope_json).map_err(|_| update_manifest_invalid())?;
    if envelope.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(update_manifest_version_unsupported());
    }
    if !validate_key_id(&envelope.key_id) {
        return Err(update_signing_key_unknown());
    }
    let pinned_key = configuration
        .public_keys
        .iter()
        .find(|key| key.id == envelope.key_id)
        .ok_or_else(update_signing_key_unknown)?;
    let payload = decode_bounded_base64url(
        &envelope.payload,
        MAX_MANIFEST_BYTES,
        "UPDATE_MANIFEST_INVALID",
    )?;
    let signature = decode_fixed_base64url::<64>(&envelope.signature, "UPDATE_SIGNATURE_INVALID")?;
    UnparsedPublicKey::new(&ED25519, pinned_key.public_key)
        .verify(&payload, &signature)
        .map_err(|_| update_signature_invalid())?;

    let manifest: SignedUpdateManifest =
        serde_json::from_slice(&payload).map_err(|_| update_manifest_invalid())?;
    let canonical = serde_json::to_vec(&manifest).map_err(|_| update_manifest_invalid())?;
    if canonical != payload {
        return Err(update_manifest_not_canonical());
    }
    if manifest.signing_key_id != envelope.key_id {
        return Err(update_signing_key_unknown());
    }
    let payload_sha256 = lower_hex(&Sha256::digest(&payload));
    validate_manifest(
        &manifest,
        configuration,
        current_version,
        now,
        payload_sha256,
    )
}

fn validate_manifest(
    manifest: &SignedUpdateManifest,
    configuration: &SecureUpdateConfiguration,
    current_version: &str,
    now: u64,
    payload_sha256: String,
) -> Result<VerifiedUpdatePlan, CommandError> {
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION
        || manifest.product != PRODUCT_ID
        || manifest.channel != configuration.channel
        || !configuration
            .public_keys
            .iter()
            .any(|key| key.id == manifest.signing_key_id)
    {
        return Err(update_manifest_scope_mismatch());
    }
    if manifest.manifest_sequence == 0 || manifest.manifest_sequence > MAX_SAFE_JSON_INTEGER {
        return Err(update_manifest_sequence_invalid());
    }
    if manifest.published_at > now.saturating_add(CLOCK_SKEW_SECONDS)
        || manifest.expires_at <= now
        || manifest.expires_at <= manifest.published_at
        || manifest.expires_at.saturating_sub(manifest.published_at) > MAX_MANIFEST_LIFETIME_SECONDS
    {
        return Err(update_manifest_expired());
    }

    let current = parse_canonical_version(current_version)?;
    let release = parse_canonical_version(&manifest.release_version)?;
    let minimum_updater = parse_canonical_version(&manifest.minimum_updater_version)?;
    let security_floor = parse_canonical_version(&manifest.security_floor_version)?;
    if security_floor > release || minimum_updater > release {
        return Err(update_version_policy_invalid());
    }
    if configuration.channel == "stable" && !release.pre.is_empty() {
        return Err(update_version_policy_invalid());
    }

    let expected_target = expected_update_target();
    if manifest.artifact.target != expected_target
        || manifest.artifact.kind != "nsis"
        || !manifest.artifact.authenticode_required
        || manifest.artifact.size_bytes == 0
        || manifest.artifact.size_bytes > MAX_ARTIFACT_BYTES
    {
        return Err(update_artifact_invalid());
    }
    let artifact_sha256_bytes =
        decode_lower_hex_sha256(&manifest.artifact.sha256).ok_or_else(update_artifact_invalid)?;
    let artifact_url = parse_https_url(&manifest.artifact.url, Some(&configuration.manifest_url))?;
    let release_notes_url = manifest
        .release_notes_url
        .as_deref()
        .map(|value| {
            parse_https_url(value, Some(&configuration.manifest_url)).map(|url| url.to_string())
        })
        .transpose()?;

    if manifest.rollback.allowed_from.len() > MAX_ROLLBACK_SOURCES {
        return Err(update_version_policy_invalid());
    }
    let mut rollback_sources = HashSet::new();
    for source in &manifest.rollback.allowed_from {
        let source_version = parse_canonical_version(source)?;
        if source_version <= release || !rollback_sources.insert(source_version) {
            return Err(update_version_policy_invalid());
        }
    }

    let (state, mandatory) = if release > current {
        if current < minimum_updater {
            (UpdatePlanState::ManualUpdateRequired, true)
        } else {
            (UpdatePlanState::UpdateAvailable, current < security_floor)
        }
    } else if release == current {
        (UpdatePlanState::UpToDate, false)
    } else {
        if release < security_floor
            || !manifest.rollback.requires_explicit_confirmation
            || !rollback_sources.contains(&current)
        {
            return Err(update_downgrade_blocked());
        }
        (UpdatePlanState::RollbackAvailable, false)
    };

    let mut plan_digest = Sha256::new();
    plan_digest.update(b"inkshadow-update-plan-v1\0");
    plan_digest.update(payload_sha256.as_bytes());
    let id = lower_hex(&plan_digest.finalize());

    Ok(VerifiedUpdatePlan {
        id,
        state,
        release_version: manifest.release_version.clone(),
        published_at: manifest.published_at,
        expires_at: manifest.expires_at,
        manifest_sequence: manifest.manifest_sequence,
        mandatory,
        payload_sha256,
        security_floor_version: manifest.security_floor_version.clone(),
        signing_key_id: manifest.signing_key_id.clone(),
        artifact_url,
        artifact_size_bytes: manifest.artifact.size_bytes,
        artifact_sha256: manifest.artifact.sha256.clone(),
        artifact_sha256_bytes,
        release_notes_url,
    })
}

fn plan_response(plan: &VerifiedUpdatePlan, current_version: &str) -> SignedUpdateCheckResponse {
    let stageable = plan.state == UpdatePlanState::UpdateAvailable;
    SignedUpdateCheckResponse {
        plan_id: stageable.then(|| plan.id.clone()),
        state: plan.state,
        current_version: current_version.to_owned(),
        release_version: plan.release_version.clone(),
        published_at: plan.published_at,
        expires_at: plan.expires_at,
        manifest_sequence: plan.manifest_sequence,
        signing_key_id: plan.signing_key_id.clone(),
        mandatory: plan.mandatory,
        artifact_size_bytes: plan.artifact_size_bytes,
        artifact_sha256: plan.artifact_sha256.clone(),
        release_notes_url: plan.release_notes_url.clone(),
        installer_execution_allowed: false,
    }
}

async fn enforce_and_persist_checkpoint(
    configuration: &SecureUpdateConfiguration,
    plan: &VerifiedUpdatePlan,
    now: u64,
) -> Result<(), CommandError> {
    let channel = configuration.channel.clone();
    let plan = plan.clone();
    tokio::task::spawn_blocking(move || {
        let account = format!("{CHECKPOINT_CREDENTIAL_PREFIX}:{PRODUCT_ID}:{channel}");
        let entry = keyring::Entry::new(CHECKPOINT_CREDENTIAL_SERVICE, &account)
            .map_err(|_| update_checkpoint_unavailable())?;
        let existing = match entry.get_password() {
            Ok(serialized) => {
                let serialized = Zeroizing::new(serialized);
                if serialized.len() > MAX_CHECKPOINT_BYTES {
                    return Err(update_checkpoint_integrity_failed());
                }
                Some(
                    serde_json::from_str::<PersistedUpdateCheckpoint>(serialized.as_str())
                        .map_err(|_| update_checkpoint_integrity_failed())?,
                )
            }
            Err(keyring::Error::NoEntry) => None,
            Err(_) => return Err(update_checkpoint_unavailable()),
        };
        let next = next_update_checkpoint(existing.as_ref(), &channel, &plan, now)?;
        let serialized =
            serde_json::to_string(&next).map_err(|_| update_checkpoint_integrity_failed())?;
        if serialized.len() > MAX_CHECKPOINT_BYTES {
            return Err(update_checkpoint_integrity_failed());
        }
        entry
            .set_password(&serialized)
            .map_err(|_| update_checkpoint_unavailable())
    })
    .await
    .map_err(|_| update_checkpoint_unavailable())?
}

fn next_update_checkpoint(
    existing: Option<&PersistedUpdateCheckpoint>,
    channel: &str,
    plan: &VerifiedUpdatePlan,
    now: u64,
) -> Result<PersistedUpdateCheckpoint, CommandError> {
    let next_floor = parse_canonical_version(&plan.security_floor_version)?;
    if !is_lower_hex_sha256(&plan.payload_sha256) {
        return Err(update_checkpoint_integrity_failed());
    }
    if let Some(existing) = existing {
        if existing.schema_version != CHECKPOINT_SCHEMA_VERSION
            || existing.product != PRODUCT_ID
            || existing.channel != channel
            || existing.highest_manifest_sequence == 0
            || !is_lower_hex_sha256(&existing.payload_sha256)
        {
            return Err(update_checkpoint_integrity_failed());
        }
        if now.saturating_add(CLOCK_SKEW_SECONDS) < existing.last_seen_time {
            return Err(update_clock_invalid());
        }
        let existing_floor = parse_canonical_version(&existing.security_floor_version)
            .map_err(|_| update_checkpoint_integrity_failed())?;
        if plan.manifest_sequence < existing.highest_manifest_sequence {
            return Err(update_manifest_replayed());
        }
        if plan.manifest_sequence == existing.highest_manifest_sequence {
            if plan.payload_sha256 != existing.payload_sha256 || next_floor != existing_floor {
                return Err(update_manifest_equivocation());
            }
        } else if next_floor < existing_floor {
            return Err(update_security_floor_regressed());
        }
    }

    Ok(PersistedUpdateCheckpoint {
        schema_version: CHECKPOINT_SCHEMA_VERSION,
        product: PRODUCT_ID.to_owned(),
        channel: channel.to_owned(),
        highest_manifest_sequence: plan.manifest_sequence,
        payload_sha256: plan.payload_sha256.clone(),
        security_floor_version: plan.security_floor_version.clone(),
        last_seen_time: existing
            .map(|checkpoint| checkpoint.last_seen_time.max(now))
            .unwrap_or(now),
    })
}

async fn stage_verified_artifact(
    plan: &VerifiedUpdatePlan,
    staging_root: &Path,
) -> Result<PathBuf, CommandError> {
    let secure_staging_root = prepare_secure_staging_root(staging_root).await?;
    let _cross_process_lock = acquire_staging_operation_lock(staging_root)?;
    enforce_staging_capacity(staging_root, plan.artifact_size_bytes).await?;
    let destination = staging_root.join(format!(
        "inkshadow-{}-s{}-{}.pending",
        plan.release_version,
        plan.manifest_sequence,
        &plan.artifact_sha256[..16]
    ));
    if fs::try_exists(&destination)
        .await
        .map_err(|_| update_stage_failed())?
    {
        return Err(update_stage_conflict());
    }

    let temporary = staging_root.join(format!(".download-{}", Uuid::now_v7()));
    let result = download_to_new_file(plan, &temporary).await;
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary).await;
        return Err(error);
    }
    if unix_time_now()? >= plan.expires_at {
        let _ = fs::remove_file(&temporary).await;
        return Err(update_manifest_expired());
    }
    if Handle::from_path(staging_root).map_err(|_| update_stage_failed())?
        != secure_staging_root.identity
        || fs::try_exists(&destination)
            .await
            .map_err(|_| update_stage_failed())?
    {
        let _ = fs::remove_file(&temporary).await;
        return Err(update_stage_conflict());
    }
    if let Err(error) = fs::rename(&temporary, &destination).await {
        let _ = fs::remove_file(&temporary).await;
        let _ = error;
        return Err(update_stage_conflict());
    }
    if !file_matches_plan(&destination, plan).await? {
        let _ = fs::remove_file(&destination).await;
        return Err(update_artifact_digest_mismatch());
    }
    if unix_time_now()? >= plan.expires_at {
        let _ = fs::remove_file(&destination).await;
        return Err(update_manifest_expired());
    }
    Ok(destination)
}

async fn prepare_secure_staging_root(
    staging_root: &Path,
) -> Result<SecureStagingRoot, CommandError> {
    #[cfg(not(windows))]
    {
        let _ = staging_root;
        return Err(update_stage_security_unavailable());
    }
    #[cfg(windows)]
    {
        fs::create_dir_all(staging_root)
            .await
            .map_err(|_| update_stage_failed())?;
        let directory_handle = open_secure_staging_directory(staging_root)?;
        let metadata = directory_handle
            .metadata()
            .map_err(|_| update_stage_security_unavailable())?;
        if !metadata_is_safe_directory(&metadata) {
            return Err(update_stage_security_unavailable());
        }
        harden_and_verify_staging_acl(&directory_handle)?;
        // Handle::from_file takes ownership of the exact CreateFileW handle.
        // Because that handle was opened without FILE_SHARE_DELETE, retaining
        // it in this guard prevents the root from being renamed, deleted, or
        // path-swapped for the complete staging operation.
        let identity =
            Handle::from_file(directory_handle).map_err(|_| update_stage_security_unavailable())?;
        if Handle::from_path(staging_root).map_err(|_| update_stage_security_unavailable())?
            != identity
        {
            return Err(update_stage_security_unavailable());
        }
        Ok(SecureStagingRoot { identity })
    }
}

#[cfg(windows)]
fn open_secure_staging_directory(staging_root: &Path) -> Result<std::fs::File, CommandError> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL, WRITE_DAC,
    };

    let path = staging_root
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: path is NUL-terminated. The returned handle is converted exactly
    // once into an owning File. Omitting FILE_SHARE_DELETE prevents the path
    // from being renamed or replaced while the staging operation is active.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            // FILE_LIST_DIRECTORY activates ordinary share accounting without
            // granting this guard delete rights. Omitting FILE_SHARE_DELETE
            // then keeps the path stable until the guard is dropped.
            READ_CONTROL | WRITE_DAC | FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(update_stage_security_unavailable());
    }
    // SAFETY: CreateFileW returned a unique, valid, owned handle above.
    Ok(unsafe { std::fs::File::from_raw_handle(handle as RawHandle) })
}

#[cfg(windows)]
fn harden_and_verify_staging_acl(staging_directory: &std::fs::File) -> Result<(), CommandError> {
    harden_and_verify_staging_acl_with_owner_policy(staging_directory, |owner, trusted_sids| {
        trusted_sids
            .iter()
            .any(|trusted| unsafe { windows_sys::Win32::Security::EqualSid(*trusted, owner) } != 0)
    })
}

#[cfg(windows)]
fn harden_and_verify_staging_acl_with_owner_policy<F>(
    staging_directory: &std::fs::File,
    owner_is_trusted: F,
) -> Result<(), CommandError>
where
    F: Fn(windows_sys::Win32::Security::PSID, &[windows_sys::Win32::Security::PSID; 3]) -> bool,
{
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::Security::Authorization::{
        GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        AclSizeInformation, AddAccessAllowedAceEx, GetAce, GetAclInformation, GetLengthSid,
        GetSecurityDescriptorControl, GetTokenInformation, InitializeAcl, IsValidAcl, IsValidSid,
        TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE, ACE_HEADER,
        ACL, ACL_REVISION, ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
        OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSID,
        SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let directory_handle = staging_directory.as_raw_handle();

    fn aligned_buffer(byte_len: usize) -> Vec<usize> {
        vec![0; byte_len.div_ceil(size_of::<usize>())]
    }

    fn well_known_sid(kind: i32) -> Result<Vec<usize>, CommandError> {
        use std::ptr::null_mut;

        use windows_sys::Win32::Security::{CreateWellKnownSid, PSID, SECURITY_MAX_SID_SIZE};

        let mut size = SECURITY_MAX_SID_SIZE;
        let mut buffer = aligned_buffer(size as usize);
        // SAFETY: buffer has SECURITY_MAX_SID_SIZE writable bytes and the
        // requested well-known SID does not require a domain SID.
        if unsafe {
            CreateWellKnownSid(
                kind,
                null_mut(),
                buffer.as_mut_ptr().cast::<core::ffi::c_void>() as PSID,
                &mut size,
            )
        } == 0
        {
            return Err(update_stage_security_unavailable());
        }
        Ok(buffer)
    }

    let mut token = null_mut();
    // SAFETY: GetCurrentProcess returns a valid pseudo-handle and token points
    // to writable storage for the returned real handle.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0
        || token.is_null()
    {
        return Err(update_stage_security_unavailable());
    }
    let token = WindowsOwnedHandle(token);

    let mut token_bytes = 0_u32;
    // SAFETY: the documented sizing call uses a null output buffer.
    let _ = unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut token_bytes) };
    if token_bytes < size_of::<TOKEN_USER>() as u32 {
        return Err(update_stage_security_unavailable());
    }
    let mut token_buffer = aligned_buffer(token_bytes as usize);
    // SAFETY: token_buffer is aligned and has at least token_bytes writable
    // bytes. TokenUser produces a TOKEN_USER whose SID points inside it.
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            token_buffer.as_mut_ptr().cast(),
            token_bytes,
            &mut token_bytes,
        )
    } == 0
    {
        return Err(update_stage_security_unavailable());
    }
    // SAFETY: the successful TokenUser query initialized TOKEN_USER.
    let current_user_sid = unsafe {
        token_buffer
            .as_ptr()
            .cast::<TOKEN_USER>()
            .as_ref()
            .map(|user| user.User.Sid)
            .ok_or_else(update_stage_security_unavailable)?
    };
    if current_user_sid.is_null() || unsafe { IsValidSid(current_user_sid) } == 0 {
        return Err(update_stage_security_unavailable());
    }

    let mut system_sid_buffer = well_known_sid(WinLocalSystemSid)?;
    let system_sid = system_sid_buffer.as_mut_ptr().cast::<core::ffi::c_void>() as PSID;
    let mut administrators_sid_buffer = well_known_sid(WinBuiltinAdministratorsSid)?;
    let administrators_sid = administrators_sid_buffer
        .as_mut_ptr()
        .cast::<core::ffi::c_void>() as PSID;
    let trusted_sids = [current_user_sid, system_sid, administrators_sid];

    let mut acl_bytes = size_of::<ACL>();
    for sid in trusted_sids {
        // SAFETY: all trusted SID pointers were validated or created by the OS.
        let sid_bytes = unsafe { GetLengthSid(sid) } as usize;
        acl_bytes = acl_bytes
            .checked_add(
                size_of::<ACCESS_ALLOWED_ACE>()
                    .saturating_sub(size_of::<u32>())
                    .saturating_add(sid_bytes),
            )
            .ok_or_else(update_stage_security_unavailable)?;
    }
    let acl_bytes = u32::try_from(acl_bytes).map_err(|_| update_stage_security_unavailable())?;
    let mut acl_buffer = aligned_buffer(acl_bytes as usize);
    let acl = acl_buffer.as_mut_ptr().cast::<ACL>();
    // SAFETY: acl_buffer is aligned and contains acl_bytes writable bytes.
    if unsafe { InitializeAcl(acl, acl_bytes, ACL_REVISION) } == 0 {
        return Err(update_stage_security_unavailable());
    }
    let inheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    for sid in trusted_sids {
        // SAFETY: acl points to an initialized ACL with enough capacity for
        // the three ACEs, and sid is valid for the lifetime of this call.
        if unsafe { AddAccessAllowedAceEx(acl, ACL_REVISION, inheritance, FILE_ALL_ACCESS, sid) }
            == 0
        {
            return Err(update_stage_security_unavailable());
        }
    }

    let mut initial_owner = null_mut();
    let mut initial_descriptor = null_mut();
    // SAFETY: directory_handle remains owned by staging_directory and all
    // output pointers are writable.
    let status = unsafe {
        GetSecurityInfo(
            directory_handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut initial_owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut initial_descriptor,
        )
    };
    let initial_descriptor = LocalSecurityDescriptor(initial_descriptor);
    if status != ERROR_SUCCESS || initial_descriptor.0.is_null() {
        return Err(update_stage_security_unavailable());
    }
    if initial_owner.is_null()
        || unsafe { IsValidSid(initial_owner) } == 0
        || !owner_is_trusted(initial_owner, &trusted_sids)
    {
        return Err(update_stage_security_unavailable());
    }
    drop(initial_descriptor);

    // SAFETY: directory_handle and acl remain valid for the call. A protected
    // DACL prevents later parent ACL changes from adding writers.
    let status = unsafe {
        SetSecurityInfo(
            directory_handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl,
            null(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(update_stage_security_unavailable());
    }

    let mut owner = null_mut();
    let mut persisted_acl = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: directory_handle remains owned by staging_directory and all
    // output pointers are writable.
    let status = unsafe {
        GetSecurityInfo(
            directory_handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut persisted_acl,
            null_mut(),
            &mut descriptor,
        )
    };
    let descriptor = LocalSecurityDescriptor(descriptor);
    if status != ERROR_SUCCESS || descriptor.0.is_null() {
        return Err(update_stage_security_unavailable());
    }
    if owner.is_null()
        || persisted_acl.is_null()
        || unsafe { IsValidSid(owner) } == 0
        || !owner_is_trusted(owner, &trusted_sids)
        || unsafe { IsValidAcl(persisted_acl) } == 0
    {
        return Err(update_stage_security_unavailable());
    }

    let mut control = 0_u16;
    let mut revision = 0_u32;
    // SAFETY: descriptor owns the security descriptor returned above.
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0
        || control & SE_DACL_PROTECTED == 0
    {
        return Err(update_stage_security_unavailable());
    }

    let mut information = ACL_SIZE_INFORMATION::default();
    // SAFETY: persisted_acl is valid and information is writable.
    if unsafe {
        GetAclInformation(
            persisted_acl,
            (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
        || information.AceCount != trusted_sids.len() as u32
    {
        return Err(update_stage_security_unavailable());
    }

    let mut seen = [false; 3];
    for index in 0..information.AceCount {
        let mut raw_ace = null_mut();
        // SAFETY: index is bounded by the ACE count obtained from the ACL.
        if unsafe { GetAce(persisted_acl, index, &mut raw_ace) } == 0 || raw_ace.is_null() {
            return Err(update_stage_security_unavailable());
        }
        // SAFETY: GetAce returned a pointer to at least an ACE_HEADER.
        let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
        if header.AceType != 0
            || header.AceFlags != inheritance as u8
            || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>()
        {
            return Err(update_stage_security_unavailable());
        }
        // SAFETY: the header checks above establish the fixed ACE prefix.
        let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
        if ace.Mask != FILE_ALL_ACCESS {
            return Err(update_stage_security_unavailable());
        }
        let sid = (&ace.SidStart as *const u32)
            .cast_mut()
            .cast::<core::ffi::c_void>() as PSID;
        if unsafe { IsValidSid(sid) } == 0 {
            return Err(update_stage_security_unavailable());
        }
        let Some(position) = trusted_sids.iter().position(
            |trusted| unsafe { windows_sys::Win32::Security::EqualSid(*trusted, sid) } != 0,
        ) else {
            return Err(update_stage_security_unavailable());
        };
        if seen[position] {
            return Err(update_stage_security_unavailable());
        }
        seen[position] = true;
    }
    if seen.iter().any(|present| !present) {
        return Err(update_stage_security_unavailable());
    }
    Ok(())
}

fn acquire_staging_operation_lock(
    staging_root: &Path,
) -> Result<StagingOperationLock, CommandError> {
    #[cfg(not(windows))]
    {
        let _ = staging_root;
        Err(update_stage_security_unavailable())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        let path = staging_root.join(UPDATE_OPERATION_LOCK);
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .share_mode(0)
            .open(&path)
            .map_err(|_| update_operation_busy())?;
        Ok(StagingOperationLock {
            file: Some(file),
            path,
        })
    }
}

async fn enforce_staging_capacity(
    staging_root: &Path,
    incoming_bytes: u64,
) -> Result<(), CommandError> {
    let mut total = 0_u64;
    let mut entries = fs::read_dir(staging_root)
        .await
        .map_err(|_| update_stage_failed())?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|_| update_stage_failed())?
    {
        let metadata = fs::symlink_metadata(entry.path())
            .await
            .map_err(|_| update_stage_failed())?;
        if !metadata_is_safe_file(&metadata) {
            return Err(update_stage_security_unavailable());
        }
        total = total
            .checked_add(metadata.len())
            .ok_or_else(update_staging_quota_exceeded)?;
    }
    if total
        .checked_add(incoming_bytes)
        .is_none_or(|value| value > MAX_STAGING_BYTES)
    {
        return Err(update_staging_quota_exceeded());
    }
    Ok(())
}

async fn download_to_new_file(
    plan: &VerifiedUpdatePlan,
    destination: &Path,
) -> Result<(), CommandError> {
    let client = build_update_client(Duration::from_secs(30 * 60))?;
    let response = client
        .get(plan.artifact_url.clone())
        .header("accept", "application/octet-stream")
        .send()
        .await
        .map_err(|_| update_fetch_failed())?;
    if response.status() != StatusCode::OK {
        return Err(update_http_status(response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length != plan.artifact_size_bytes)
    {
        return Err(update_artifact_size_mismatch());
    }

    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .await
        .map_err(|_| update_stage_failed())?;
    let mut stream = response.bytes_stream();
    let mut size = 0_u64;
    let mut digest = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| update_fetch_failed())?;
        size = size
            .checked_add(chunk.len() as u64)
            .ok_or_else(update_artifact_size_mismatch)?;
        if size > plan.artifact_size_bytes || size > MAX_ARTIFACT_BYTES {
            return Err(update_artifact_size_mismatch());
        }
        digest.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|_| update_stage_failed())?;
    }
    if size != plan.artifact_size_bytes
        || digest.finalize().as_slice() != plan.artifact_sha256_bytes
    {
        return Err(update_artifact_digest_mismatch());
    }
    file.flush().await.map_err(|_| update_stage_failed())?;
    file.sync_all().await.map_err(|_| update_stage_failed())?;
    Ok(())
}

async fn file_matches_plan(path: &Path, plan: &VerifiedUpdatePlan) -> Result<bool, CommandError> {
    if !fs::try_exists(path)
        .await
        .map_err(|_| update_stage_failed())?
    {
        return Ok(false);
    }
    let metadata = fs::symlink_metadata(path)
        .await
        .map_err(|_| update_stage_failed())?;
    if !metadata_is_safe_file(&metadata) || metadata.len() != plan.artifact_size_bytes {
        return Ok(false);
    }
    let standard_file = std::fs::File::open(path).map_err(|_| update_stage_failed())?;
    let identity = Handle::from_file(
        standard_file
            .try_clone()
            .map_err(|_| update_stage_failed())?,
    )
    .map_err(|_| update_stage_failed())?;
    let mut file = fs::File::from_std(standard_file);
    let opened_metadata = file.metadata().await.map_err(|_| update_stage_failed())?;
    if !metadata_is_safe_file(&opened_metadata) || opened_metadata.len() != plan.artifact_size_bytes
    {
        return Ok(false);
    }
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|_| update_stage_failed())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest.finalize().as_slice() == plan.artifact_sha256_bytes
        && Handle::from_path(path).is_ok_and(|current| current == identity))
}

fn metadata_is_safe_directory(metadata: &std::fs::Metadata) -> bool {
    metadata.is_dir() && !metadata_is_reparse_point(metadata)
}

fn metadata_is_safe_file(metadata: &std::fs::Metadata) -> bool {
    metadata.is_file() && !metadata_is_reparse_point(metadata)
}

fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        true
    }
}

fn parse_https_url(value: &str, same_origin_as: Option<&Url>) -> Result<Url, CommandError> {
    if value.len() > 2048 || value.trim() != value {
        return Err(update_artifact_origin_invalid());
    }
    let url = Url::parse(value).map_err(|_| update_artifact_origin_invalid())?;
    let host = url.host_str().ok_or_else(update_artifact_origin_invalid)?;
    let normalized_host = host.trim_end_matches('.').to_ascii_lowercase();
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
        || normalized_host == "localhost"
        || normalized_host.ends_with(".localhost")
        || normalized_host.ends_with(".local")
        || (host_is_ip_literal(host) && !literal_ip_is_public(host))
    {
        return Err(update_artifact_origin_invalid());
    }
    if same_origin_as.is_some_and(|origin| !same_origin(origin, &url)) {
        return Err(update_artifact_origin_invalid());
    }
    Ok(url)
}

fn literal_ip_is_public(host: &str) -> bool {
    let normalized = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    normalized.parse::<IpAddr>().is_ok_and(|address| {
        let loopback_or_unspecified = match address {
            IpAddr::V4(address) => address.is_loopback() || address.is_unspecified(),
            IpAddr::V6(address) => {
                address.is_loopback()
                    || address.is_unspecified()
                    || address
                        .to_ipv4_mapped()
                        .is_some_and(|mapped| mapped.is_loopback() || mapped.is_unspecified())
            }
        };
        !loopback_or_unspecified && literal_ip_is_allowed(host)
    })
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left
            .host_str()
            .zip(right.host_str())
            .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right))
        && left.port_or_known_default() == right.port_or_known_default()
}

fn parse_canonical_version(value: &str) -> Result<Version, CommandError> {
    if value.len() > 64 || value.trim() != value {
        return Err(update_version_policy_invalid());
    }
    let version = Version::parse(value).map_err(|_| update_version_policy_invalid())?;
    if !version.build.is_empty() || version.to_string() != value {
        return Err(update_version_policy_invalid());
    }
    Ok(version)
}

fn validate_key_id(value: &str) -> bool {
    (3..=64).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'0'..=b'9' => true,
            b'.' | b'_' | b'-' => index > 0,
            _ => false,
        })
}

fn expected_update_target() -> String {
    format!("windows-{}", std::env::consts::ARCH)
}

fn decode_bounded_base64url(
    value: &str,
    max_decoded_len: usize,
    _code: &'static str,
) -> Result<Vec<u8>, CommandError> {
    if value.is_empty()
        || value.contains('=')
        || value.len() > max_decoded_len.saturating_mul(4).saturating_add(3) / 3
    {
        return Err(update_manifest_invalid());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| update_manifest_invalid())?;
    if decoded.len() > max_decoded_len || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(update_manifest_invalid());
    }
    Ok(decoded)
}

fn decode_fixed_base64url<const N: usize>(
    value: &str,
    _code: &'static str,
) -> Result<[u8; N], CommandError> {
    let decoded = decode_bounded_base64url(value, N, "UPDATE_BASE64URL_INVALID")?;
    decoded.try_into().map_err(|_| update_signature_invalid())
}

fn decode_lower_hex_sha256(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let start = index * 2;
        *byte = u8::from_str_radix(&value[start..start + 2], 16).ok()?;
    }
    Some(bytes)
}

fn is_lower_hex_sha256(value: &str) -> bool {
    decode_lower_hex_sha256(value).is_some()
}

fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn unix_time_now() -> Result<u64, CommandError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| update_clock_invalid())
}

fn update_configuration_missing() -> CommandError {
    CommandError::new(
        "UPDATE_CONFIGURATION_MISSING",
        "The signed update channel is not pinned in this build.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_configuration_invalid() -> CommandError {
    CommandError::new(
        "UPDATE_CONFIGURATION_INVALID",
        "The signed update configuration is invalid.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_operation_busy() -> CommandError {
    CommandError::new(
        "UPDATE_OPERATION_BUSY",
        "Another update operation is still active.",
        true,
        vec!["WAIT", "RETRY"],
    )
}

fn update_fetch_failed() -> CommandError {
    CommandError::new(
        "UPDATE_FETCH_FAILED",
        "The update service could not be reached safely.",
        true,
        vec!["RETRY", "USE_MANUAL_DOWNLOAD"],
    )
}

fn update_http_status(status: StatusCode) -> CommandError {
    match status.as_u16() {
        408 | 429 | 500..=599 => update_fetch_failed(),
        _ => CommandError::new(
            "UPDATE_HTTP_STATUS_REJECTED",
            "The update service returned an unexpected status.",
            false,
            vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
        ),
    }
}

fn update_manifest_too_large() -> CommandError {
    CommandError::new(
        "UPDATE_MANIFEST_TOO_LARGE",
        "The update manifest exceeds the safety limit.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_manifest_invalid() -> CommandError {
    CommandError::new(
        "UPDATE_MANIFEST_INVALID",
        "The update manifest is malformed.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_manifest_not_canonical() -> CommandError {
    CommandError::new(
        "UPDATE_MANIFEST_NOT_CANONICAL",
        "The signed update payload is not in its canonical representation.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_manifest_version_unsupported() -> CommandError {
    CommandError::new(
        "UPDATE_MANIFEST_VERSION_UNSUPPORTED",
        "This app cannot safely process the update manifest version.",
        false,
        vec!["USE_MANUAL_DOWNLOAD"],
    )
}

fn update_signature_invalid() -> CommandError {
    CommandError::new(
        "UPDATE_SIGNATURE_INVALID",
        "The update manifest signature could not be verified.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_signing_key_unknown() -> CommandError {
    CommandError::new(
        "UPDATE_SIGNING_KEY_UNKNOWN",
        "The update envelope does not select a key pinned in this build.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_manifest_scope_mismatch() -> CommandError {
    CommandError::new(
        "UPDATE_MANIFEST_SCOPE_MISMATCH",
        "The update manifest is for a different product or channel.",
        false,
        vec!["USE_MANUAL_DOWNLOAD"],
    )
}

fn update_manifest_expired() -> CommandError {
    CommandError::new(
        "UPDATE_MANIFEST_EXPIRED",
        "The update manifest is expired or outside its validity window.",
        true,
        vec!["RETRY", "USE_MANUAL_DOWNLOAD"],
    )
}

fn update_version_policy_invalid() -> CommandError {
    CommandError::new(
        "UPDATE_VERSION_POLICY_INVALID",
        "The signed update version policy is invalid.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_manifest_sequence_invalid() -> CommandError {
    CommandError::new(
        "UPDATE_MANIFEST_SEQUENCE_INVALID",
        "The signed update sequence is outside the supported monotonic range.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_manifest_replayed() -> CommandError {
    CommandError::new(
        "UPDATE_MANIFEST_REPLAYED",
        "The signed update manifest is older than the last accepted checkpoint.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_manifest_equivocation() -> CommandError {
    CommandError::new(
        "UPDATE_MANIFEST_EQUIVOCATION",
        "The update source reused a manifest sequence with different signed content.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_security_floor_regressed() -> CommandError {
    CommandError::new(
        "UPDATE_SECURITY_FLOOR_REGRESSED",
        "The signed update attempts to lower the persisted security floor.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_checkpoint_unavailable() -> CommandError {
    CommandError::new(
        "UPDATE_CHECKPOINT_UNAVAILABLE",
        "The protected anti-replay checkpoint is unavailable.",
        true,
        vec!["RETRY", "USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_checkpoint_integrity_failed() -> CommandError {
    CommandError::new(
        "UPDATE_CHECKPOINT_INTEGRITY_FAILED",
        "The protected anti-replay checkpoint is invalid or inconsistent.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_downgrade_blocked() -> CommandError {
    CommandError::new(
        "UPDATE_DOWNGRADE_BLOCKED",
        "The signed manifest does not authorize this exact rollback.",
        false,
        vec!["KEEP_CURRENT_VERSION", "CONTACT_SUPPORT"],
    )
}

fn update_artifact_invalid() -> CommandError {
    CommandError::new(
        "UPDATE_ARTIFACT_INVALID",
        "The signed update artifact metadata is invalid.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_artifact_origin_invalid() -> CommandError {
    CommandError::new(
        "UPDATE_ARTIFACT_ORIGIN_INVALID",
        "The update URL does not satisfy the pinned HTTPS origin policy.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_plan_missing() -> CommandError {
    CommandError::new(
        "UPDATE_PLAN_MISSING",
        "The verified update plan is missing or stale.",
        true,
        vec!["CHECK_FOR_UPDATES"],
    )
}

fn update_plan_not_stageable() -> CommandError {
    CommandError::new(
        "UPDATE_PLAN_NOT_STAGEABLE",
        "This update plan cannot be staged by the current app version.",
        false,
        vec!["USE_MANUAL_DOWNLOAD"],
    )
}

fn update_artifact_size_mismatch() -> CommandError {
    CommandError::new(
        "UPDATE_ARTIFACT_SIZE_MISMATCH",
        "The downloaded update size does not match the signed manifest.",
        true,
        vec!["RETRY", "USE_MANUAL_DOWNLOAD"],
    )
}

fn update_artifact_digest_mismatch() -> CommandError {
    CommandError::new(
        "UPDATE_ARTIFACT_DIGEST_MISMATCH",
        "The downloaded update digest does not match the signed manifest.",
        false,
        vec!["DELETE_STAGED_PACKAGE", "CONTACT_SUPPORT"],
    )
}

fn update_stage_failed() -> CommandError {
    CommandError::new(
        "UPDATE_STAGE_FAILED",
        "The verified update package could not be staged.",
        true,
        vec!["RETRY", "CHECK_DISK_SPACE"],
    )
}

fn update_stage_conflict() -> CommandError {
    CommandError::new(
        "UPDATE_STAGE_CONFLICT",
        "A different package already occupies the verified staging target.",
        false,
        vec!["OPEN_DIAGNOSTICS", "CONTACT_SUPPORT"],
    )
}

fn update_stage_security_unavailable() -> CommandError {
    CommandError::new(
        "UPDATE_STAGE_SECURITY_UNAVAILABLE",
        "The staging directory does not satisfy the Windows ACL or reparse-point safety policy.",
        false,
        vec!["USE_MANUAL_DOWNLOAD", "CONTACT_SUPPORT"],
    )
}

fn update_staging_quota_exceeded() -> CommandError {
    CommandError::new(
        "UPDATE_STAGING_QUOTA_EXCEEDED",
        "The bounded secure-update staging quota is exhausted.",
        false,
        vec!["OPEN_DIAGNOSTICS", "CONTACT_SUPPORT"],
    )
}

fn update_clock_invalid() -> CommandError {
    CommandError::new(
        "UPDATE_CLOCK_INVALID",
        "The system clock cannot validate the signed update window.",
        false,
        vec!["CHECK_SYSTEM_TIME"],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    const NOW: u64 = 2_000_000_000;

    fn signing_key() -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[7_u8; 32]).expect("test key")
    }

    fn configuration() -> SecureUpdateConfiguration {
        let signing_key = signing_key();
        SecureUpdateConfiguration {
            channel: "stable".to_owned(),
            manifest_url: Url::parse("https://updates.inkshadow.example/v1/stable.json")
                .expect("URL"),
            public_keys: vec![PinnedManifestKey {
                id: "release-2026-a".to_owned(),
                public_key: signing_key
                    .public_key()
                    .as_ref()
                    .try_into()
                    .expect("public key"),
            }],
        }
    }

    fn manifest(release_version: &str) -> SignedUpdateManifest {
        SignedUpdateManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            product: PRODUCT_ID.to_owned(),
            channel: "stable".to_owned(),
            signing_key_id: "release-2026-a".to_owned(),
            manifest_sequence: 7,
            release_version: release_version.to_owned(),
            minimum_updater_version: "0.1.0".to_owned(),
            security_floor_version: "0.1.0".to_owned(),
            published_at: NOW - 60,
            expires_at: NOW + 3_600,
            artifact: SignedUpdateArtifact {
                target: expected_update_target(),
                kind: "nsis".to_owned(),
                url: "https://updates.inkshadow.example/artifacts/inkshadow.exe".to_owned(),
                size_bytes: 4,
                sha256: "0".repeat(64),
                authenticode_required: true,
            },
            rollback: SignedRollbackPolicy {
                allowed_from: Vec::new(),
                requires_explicit_confirmation: true,
            },
            release_notes_url: Some("https://updates.inkshadow.example/releases/0.2.0".to_owned()),
        }
    }

    fn signed_envelope(manifest: &SignedUpdateManifest) -> String {
        let payload = serde_json::to_vec(manifest).expect("serialize");
        let signature = signing_key().sign(&payload);
        serde_json::json!({
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "keyId": &manifest.signing_key_id,
            "payload": URL_SAFE_NO_PAD.encode(payload),
            "signature": URL_SAFE_NO_PAD.encode(signature.as_ref()),
        })
        .to_string()
    }

    #[cfg(windows)]
    #[derive(Debug, PartialEq, Eq)]
    struct StagingDaclSnapshot {
        protected: bool,
        bytes: Vec<u8>,
    }

    #[cfg(windows)]
    fn staging_dacl_snapshot(staging_directory: &std::fs::File) -> StagingDaclSnapshot {
        use std::mem::size_of;
        use std::os::windows::io::AsRawHandle;
        use std::ptr::null_mut;

        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
        use windows_sys::Win32::Security::{
            AclSizeInformation, GetAclInformation, GetSecurityDescriptorControl, IsValidAcl,
            ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
        };

        let mut acl = null_mut();
        let mut descriptor = null_mut();
        // SAFETY: the file owns a live directory handle and every output
        // pointer refers to writable local storage.
        let status = unsafe {
            GetSecurityInfo(
                staging_directory.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor,
            )
        };
        let descriptor = LocalSecurityDescriptor(descriptor);
        assert_eq!(status, ERROR_SUCCESS, "read staging DACL");
        assert!(!descriptor.0.is_null(), "security descriptor");
        assert!(!acl.is_null(), "staging DACL");
        // SAFETY: GetSecurityInfo returned a valid descriptor and DACL above.
        assert_ne!(unsafe { IsValidAcl(acl) }, 0, "valid staging DACL");

        let mut control = 0_u16;
        let mut revision = 0_u32;
        // SAFETY: descriptor remains owned by the local RAII wrapper.
        assert_ne!(
            unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) },
            0,
            "read descriptor control"
        );
        let mut information = ACL_SIZE_INFORMATION::default();
        // SAFETY: acl is valid and information is writable.
        assert_ne!(
            unsafe {
                GetAclInformation(
                    acl,
                    (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                )
            },
            0,
            "read DACL size"
        );
        // SAFETY: AclBytesInUse is the OS-reported initialized extent of the
        // valid ACL and the descriptor remains alive while it is copied.
        let bytes = unsafe {
            std::slice::from_raw_parts(acl.cast::<u8>(), information.AclBytesInUse as usize)
        }
        .to_vec();
        StagingDaclSnapshot {
            protected: control & SE_DACL_PROTECTED != 0,
            bytes,
        }
    }

    #[cfg(windows)]
    fn make_staging_dacl_unprotected(staging_directory: &std::fs::File) {
        use std::os::windows::io::AsRawHandle;
        use std::ptr::{null, null_mut};

        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::Security::Authorization::{
            GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT,
        };
        use windows_sys::Win32::Security::{
            DACL_SECURITY_INFORMATION, UNPROTECTED_DACL_SECURITY_INFORMATION,
        };

        let mut acl = null_mut();
        let mut descriptor = null_mut();
        // SAFETY: the file owns a live directory handle and every output
        // pointer refers to writable local storage.
        let status = unsafe {
            GetSecurityInfo(
                staging_directory.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor,
            )
        };
        let descriptor = LocalSecurityDescriptor(descriptor);
        assert_eq!(status, ERROR_SUCCESS, "read DACL for test setup");
        assert!(!descriptor.0.is_null(), "security descriptor");
        assert!(!acl.is_null(), "staging DACL");
        // SAFETY: the handle and descriptor-owned ACL remain valid for this
        // call. The test changes only its unique temporary directory.
        let status = unsafe {
            SetSecurityInfo(
                staging_directory.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null(),
            )
        };
        assert_eq!(status, ERROR_SUCCESS, "make test DACL unprotected");
        drop(descriptor);
    }

    #[test]
    fn verifies_an_exact_upgrade_and_never_authorizes_installer_execution() {
        let plan = verify_update_envelope(
            &signed_envelope(&manifest("0.2.0")),
            &configuration(),
            "0.1.0",
            NOW,
        )
        .expect("verified update");
        assert_eq!(plan.state, UpdatePlanState::UpdateAvailable);
        let response = plan_response(&plan, "0.1.0");
        assert!(response.plan_id.is_some());
        assert!(!response.installer_execution_allowed);
    }

    #[test]
    fn rejects_tampering_noncanonical_payload_and_cross_origin_artifacts() {
        let mut envelope: serde_json::Value =
            serde_json::from_str(&signed_envelope(&manifest("0.2.0"))).expect("envelope");
        envelope["signature"] = serde_json::Value::String(URL_SAFE_NO_PAD.encode([1_u8; 64]));
        assert_eq!(
            verify_update_envelope(&envelope.to_string(), &configuration(), "0.1.0", NOW)
                .expect_err("tampering")
                .code(),
            "UPDATE_SIGNATURE_INVALID"
        );

        let payload = serde_json::to_string_pretty(&manifest("0.2.0"))
            .expect("pretty payload")
            .into_bytes();
        let signature = signing_key().sign(&payload);
        let envelope = serde_json::json!({
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "keyId": "release-2026-a",
            "payload": URL_SAFE_NO_PAD.encode(payload),
            "signature": URL_SAFE_NO_PAD.encode(signature.as_ref()),
        });
        assert_eq!(
            verify_update_envelope(&envelope.to_string(), &configuration(), "0.1.0", NOW)
                .expect_err("noncanonical")
                .code(),
            "UPDATE_MANIFEST_NOT_CANONICAL"
        );

        let mut cross_origin = manifest("0.2.0");
        cross_origin.artifact.url = "https://cdn.attacker.example/update.exe".to_owned();
        assert_eq!(
            verify_update_envelope(
                &signed_envelope(&cross_origin),
                &configuration(),
                "0.1.0",
                NOW,
            )
            .expect_err("cross origin")
            .code(),
            "UPDATE_ARTIFACT_ORIGIN_INVALID"
        );

        let mut unknown_key: serde_json::Value =
            serde_json::from_str(&signed_envelope(&manifest("0.2.0"))).expect("envelope");
        unknown_key["keyId"] = serde_json::Value::String("release-2026-unknown".to_owned());
        assert_eq!(
            verify_update_envelope(&unknown_key.to_string(), &configuration(), "0.1.0", NOW)
                .expect_err("unknown key")
                .code(),
            "UPDATE_SIGNING_KEY_UNKNOWN"
        );
    }

    #[test]
    fn only_allows_an_exact_signed_rollback_above_the_security_floor() {
        let mut denied = manifest("0.1.0");
        assert_eq!(
            verify_update_envelope(&signed_envelope(&denied), &configuration(), "0.2.0", NOW,)
                .expect_err("rollback denied")
                .code(),
            "UPDATE_DOWNGRADE_BLOCKED"
        );

        denied.rollback.allowed_from = vec!["0.2.0".to_owned()];
        let plan =
            verify_update_envelope(&signed_envelope(&denied), &configuration(), "0.2.0", NOW)
                .expect("authorized rollback");
        assert_eq!(plan.state, UpdatePlanState::RollbackAvailable);
        assert!(plan_response(&plan, "0.2.0").plan_id.is_none());

        denied.security_floor_version = "0.1.1".to_owned();
        assert_eq!(
            verify_update_envelope(&signed_envelope(&denied), &configuration(), "0.2.0", NOW,)
                .expect_err("below floor")
                .code(),
            "UPDATE_VERSION_POLICY_INVALID"
        );
    }

    #[test]
    fn rejects_expired_long_lived_and_manual_only_manifests() {
        let mut expired = manifest("0.2.0");
        expired.expires_at = NOW - 1;
        assert_eq!(
            verify_update_envelope(&signed_envelope(&expired), &configuration(), "0.1.0", NOW,)
                .expect_err("expired")
                .code(),
            "UPDATE_MANIFEST_EXPIRED"
        );

        let mut long_lived = manifest("0.2.0");
        long_lived.expires_at = long_lived.published_at + MAX_MANIFEST_LIFETIME_SECONDS + 1;
        assert_eq!(
            verify_update_envelope(
                &signed_envelope(&long_lived),
                &configuration(),
                "0.1.0",
                NOW,
            )
            .expect_err("long lived")
            .code(),
            "UPDATE_MANIFEST_EXPIRED"
        );

        let mut future = manifest("0.2.0");
        future.published_at = NOW + CLOCK_SKEW_SECONDS + 1;
        future.expires_at = future.published_at + 3_600;
        assert_eq!(
            verify_update_envelope(&signed_envelope(&future), &configuration(), "0.1.0", NOW,)
                .expect_err("future")
                .code(),
            "UPDATE_MANIFEST_EXPIRED"
        );

        let mut manual = manifest("0.3.0");
        manual.minimum_updater_version = "0.2.0".to_owned();
        let plan =
            verify_update_envelope(&signed_envelope(&manual), &configuration(), "0.1.0", NOW)
                .expect("manual update");
        assert_eq!(plan.state, UpdatePlanState::ManualUpdateRequired);
        assert!(plan_response(&plan, "0.1.0").plan_id.is_none());
    }

    #[test]
    fn enforces_canonical_encodings_versions_and_https_origin() {
        assert!(decode_lower_hex_sha256(&"a".repeat(64)).is_some());
        assert!(decode_lower_hex_sha256(&"A".repeat(64)).is_none());
        assert!(parse_canonical_version("01.2.3").is_err());
        assert!(parse_canonical_version("1.2.3+build").is_err());
        assert!(parse_https_url("http://updates.inkshadow.example/file", None).is_err());
        assert!(
            parse_https_url("https://updates.inkshadow.example/file?token=secret", None).is_err()
        );
        assert!(parse_https_url("https://169.254.169.254/file", None).is_err());
        assert!(parse_https_url("https://127.0.0.1/file", None).is_err());
        assert!(parse_https_url("https://[::ffff:127.0.0.1]/file", None).is_err());
        assert!(parse_https_url("https://localhost/file", None).is_err());
        assert!(parse_https_url("https://updates.local/file", None).is_err());
        assert!(validate_key_id("release-2026-a"));
        assert!(!validate_key_id("Release 2026"));

        let mut imprecise_sequence = manifest("0.2.0");
        imprecise_sequence.manifest_sequence = MAX_SAFE_JSON_INTEGER + 1;
        assert_eq!(
            verify_update_envelope(
                &signed_envelope(&imprecise_sequence),
                &configuration(),
                "0.1.0",
                NOW,
            )
            .expect_err("unsafe JSON integer")
            .code(),
            "UPDATE_MANIFEST_SEQUENCE_INVALID"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn hardens_staging_acl_and_holds_the_directory_identity_guard() {
        let staging_root =
            std::env::temp_dir().join(format!("inkshadow-updater-test-{}", Uuid::now_v7()));
        let displaced_root = staging_root.with_extension("displaced");
        let replacement_root = staging_root.with_extension("replacement");
        std::fs::create_dir(&staging_root).expect("create staging root");
        std::fs::create_dir(&replacement_root).expect("create replacement root");
        let staging_directory = open_secure_staging_directory(&staging_root).expect("open root");
        harden_and_verify_staging_acl(&staging_directory).expect("secure ACL");
        harden_and_verify_staging_acl(&staging_directory).expect("idempotent secure ACL");
        drop(staging_directory);
        let secure_staging_root = prepare_secure_staging_root(&staging_root)
            .await
            .expect("secure root");

        {
            let _lock = acquire_staging_operation_lock(&staging_root).expect("first lock");
            assert!(staging_root.join(UPDATE_OPERATION_LOCK).is_file());
            assert_eq!(
                acquire_staging_operation_lock(&staging_root)
                    .err()
                    .expect("second lock denied")
                    .code(),
                "UPDATE_OPERATION_BUSY"
            );
        }
        assert!(!staging_root.join(UPDATE_OPERATION_LOCK).exists());
        assert!(std::fs::rename(&staging_root, &displaced_root).is_err());
        assert!(std::fs::remove_dir(&staging_root).is_err());
        assert!(staging_root.is_dir());

        drop(secure_staging_root);
        std::fs::rename(&staging_root, &displaced_root).expect("rename after guard release");
        std::fs::rename(&replacement_root, &staging_root).expect("swap after guard release");
        std::fs::remove_dir(&displaced_root).expect("remove displaced root");
        std::fs::remove_dir(&staging_root).expect("remove replacement root");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_an_untrusted_owner_before_mutating_the_dacl() {
        let staging_root =
            std::env::temp_dir().join(format!("inkshadow-owner-test-{}", Uuid::now_v7()));
        std::fs::create_dir(&staging_root).expect("create staging root");
        let staging_directory = open_secure_staging_directory(&staging_root).expect("open root");
        make_staging_dacl_unprotected(&staging_directory);
        let before = staging_dacl_snapshot(&staging_directory);
        assert!(!before.protected, "test starts with an unprotected DACL");

        let error = harden_and_verify_staging_acl_with_owner_policy(
            &staging_directory,
            |_owner, _trusted_sids| false,
        )
        .expect_err("untrusted owner must fail closed");
        assert_eq!(error.code(), "UPDATE_STAGE_SECURITY_UNAVAILABLE");
        assert_eq!(
            staging_dacl_snapshot(&staging_directory),
            before,
            "owner rejection must happen before any DACL write"
        );

        drop(staging_directory);
        std::fs::remove_dir(&staging_root).expect("remove staging root");
    }

    #[test]
    fn persists_monotonic_sequence_digest_floor_and_last_seen_time() {
        let verified = verify_update_envelope(
            &signed_envelope(&manifest("0.2.0")),
            &configuration(),
            "0.1.0",
            NOW,
        )
        .expect("verified update");
        let checkpoint =
            next_update_checkpoint(None, "stable", &verified, NOW).expect("initial checkpoint");

        let same = next_update_checkpoint(Some(&checkpoint), "stable", &verified, NOW + 30)
            .expect("idempotent checkpoint");
        assert_eq!(same.highest_manifest_sequence, 7);
        assert_eq!(same.last_seen_time, NOW + 30);

        let mut replayed = verified.clone();
        replayed.manifest_sequence = 6;
        replayed.payload_sha256 = "1".repeat(64);
        assert_eq!(
            next_update_checkpoint(Some(&same), "stable", &replayed, NOW + 31)
                .expect_err("replay")
                .code(),
            "UPDATE_MANIFEST_REPLAYED"
        );

        let mut equivocation = verified.clone();
        equivocation.payload_sha256 = "2".repeat(64);
        assert_eq!(
            next_update_checkpoint(Some(&same), "stable", &equivocation, NOW + 31)
                .expect_err("equivocation")
                .code(),
            "UPDATE_MANIFEST_EQUIVOCATION"
        );

        let mut lower_floor = verified.clone();
        lower_floor.manifest_sequence = 8;
        lower_floor.payload_sha256 = "3".repeat(64);
        lower_floor.security_floor_version = "0.0.1".to_owned();
        assert_eq!(
            next_update_checkpoint(Some(&same), "stable", &lower_floor, NOW + 31)
                .expect_err("floor regression")
                .code(),
            "UPDATE_SECURITY_FLOOR_REGRESSED"
        );

        assert_eq!(
            next_update_checkpoint(
                Some(&same),
                "stable",
                &verified,
                NOW - CLOCK_SKEW_SECONDS - 1,
            )
            .expect_err("clock rollback")
            .code(),
            "UPDATE_CLOCK_INVALID"
        );
    }
}
