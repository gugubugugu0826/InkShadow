use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rand::RngCore;
use same_file::Handle;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use tauri::{AppHandle, Manager};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::io::AsyncReadExt;
use uuid::{Uuid, Variant};

use crate::model_gateway::CommandError;

const AUTOMATIC_BACKUP_DIRECTORY: &str = "automatic-backups";
const AUTOMATIC_BACKUP_VERSION_DIRECTORY: &str = "v1";
const ROOT_MARKER_FILE: &str = ".inkshadow-automatic-backup-root-v1.json";
const MANIFEST_FILE_V1: &str = ".inkshadow-automatic-backup-manifest-v1.json";
const MANIFEST_FILE_V2: &str = ".inkshadow-automatic-backup-manifest-v2.json";
const LEASE_DIRECTORY: &str = ".inkshadow-automatic-backup-lease-v1";
const LEASE_RECORD_FILE: &str = "lease.json";
const MAX_METADATA_BYTES: u64 = 4 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES: usize = 4_096;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;
const REPARSE_POINT_ATTRIBUTE: u32 = 0x0000_0400;
const DATABASE_FILE_NAME: &str = "inkshadow.db";
const BACKUP_OPERATION_TIMEOUT: Duration = Duration::from_secs(120);
const DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
static AUTOMATIC_BACKUP_RUNTIME_ID: OnceLock<String> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnershipMarker {
    product: String,
    purpose: String,
    schema_version: u8,
    root_id: String,
}

#[derive(Clone, Debug)]
struct ManagedRoot {
    path: PathBuf,
    absolute_path: String,
    marker: OwnershipMarker,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomaticBackupRootInspection {
    absolute_path: String,
    canonical_absolute_path: String,
    ownership_marker: OwnershipMarker,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseRecord {
    schema_version: u8,
    root_id: String,
    token: String,
    owner_id: String,
    #[serde(default)]
    runtime_id: Option<String>,
    acquired_unix_ms: u64,
    expires_unix_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct LeaseReceipt {
    token: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AutomaticBackupFileRequest {
    backup_id: String,
    file_name: String,
    absolute_path: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    byte_length: Option<u64>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    retention_until: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", untagged)]
pub(crate) enum AutomaticBackupFileInspection {
    Missing {
        exists: bool,
    },
    Present {
        exists: bool,
        file_name: String,
        absolute_path: String,
        canonical_absolute_path: String,
        byte_length: u64,
        sha256: String,
        integrity_verified: bool,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome")]
pub(crate) enum AutomaticBackupCreationOutcome {
    #[serde(rename = "succeeded")]
    Succeeded { file: AutomaticBackupFileInspection },
    #[serde(rename = "not_started")]
    NotStarted {
        #[serde(rename = "failureKind")]
        failure_kind: &'static str,
    },
    #[serde(rename = "failed")]
    Failed {
        #[serde(rename = "failureKind")]
        failure_kind: &'static str,
    },
    #[serde(rename = "unknown")]
    Unknown {
        #[serde(rename = "failureKind")]
        failure_kind: &'static str,
    },
}

#[tauri::command]
pub(crate) fn native_automatic_backup_inspect_root(
    app: AppHandle,
) -> Result<AutomaticBackupRootInspection, CommandError> {
    let base = app.path().app_data_dir().map_err(|_| root_unavailable())?;
    let root = resolve_managed_root(&base)?;
    Ok(root_inspection(&root))
}

#[tauri::command]
pub(crate) fn native_automatic_backup_acquire_lease(
    app: AppHandle,
    root_id: String,
    owner_id: String,
    lease_duration_minutes: u64,
) -> Result<Option<LeaseReceipt>, CommandError> {
    if !valid_uuid_v7(&owner_id) || !(5..=1_440).contains(&lease_duration_minutes) {
        return Err(lease_invalid());
    }
    let root = resolve_checked_root(&app, &root_id)?;
    acquire_lease_at(
        &root,
        &owner_id,
        lease_duration_minutes,
        unix_time_millis()?,
    )
}

#[tauri::command]
pub(crate) fn native_automatic_backup_release_lease(
    app: AppHandle,
    root_id: String,
    lease_token: String,
) -> Result<(), CommandError> {
    let root = resolve_checked_root(&app, &root_id)?;
    release_lease(&root, &lease_token)
}

#[tauri::command]
pub(crate) fn native_automatic_backup_read_manifest(
    app: AppHandle,
    root_id: String,
    lease_token: String,
) -> Result<Option<JsonValue>, CommandError> {
    let root = resolve_checked_root(&app, &root_id)?;
    require_lease(&root, &lease_token, unix_time_millis()?)?;
    read_manifest(&root)
}

#[tauri::command]
pub(crate) fn native_automatic_backup_write_manifest(
    app: AppHandle,
    root_id: String,
    lease_token: String,
    expected_revision: u64,
    manifest: JsonValue,
) -> Result<JsonValue, CommandError> {
    let root = resolve_checked_root(&app, &root_id)?;
    require_lease(&root, &lease_token, unix_time_millis()?)?;
    write_manifest(&root, &lease_token, expected_revision, &manifest)?;
    Ok(manifest)
}

#[tauri::command]
pub(crate) async fn native_automatic_backup_create_verified(
    app: AppHandle,
    root_id: String,
    lease_token: String,
    request: AutomaticBackupFileRequest,
) -> Result<AutomaticBackupCreationOutcome, CommandError> {
    // Keep the command future small. Tauri constructs it on the Windows main
    // thread, whose stack is much smaller than this backup state machine.
    Box::pin(native_automatic_backup_create_verified_inner(
        app,
        root_id,
        lease_token,
        request,
    ))
    .await
}

async fn native_automatic_backup_create_verified_inner(
    app: AppHandle,
    root_id: String,
    lease_token: String,
    request: AutomaticBackupFileRequest,
) -> Result<AutomaticBackupCreationOutcome, CommandError> {
    let root = resolve_checked_root(&app, &root_id)?;
    require_lease(&root, &lease_token, unix_time_millis()?)?;
    validate_file_request(&root, &request)?;
    require_manifest_entry(&root, &request, "writing")?;

    let config_directory = app
        .path()
        .app_config_dir()
        .map_err(|_| root_unavailable())?;
    let source = config_directory.join(DATABASE_FILE_NAME);
    match tokio::time::timeout(
        BACKUP_OPERATION_TIMEOUT,
        Box::pin(create_verified_backup(&source, &root, &request)),
    )
    .await
    {
        Ok(outcome) => Ok(outcome),
        Err(_) => Ok(AutomaticBackupCreationOutcome::Unknown {
            failure_kind: "result_unconfirmed",
        }),
    }
}

#[tauri::command]
pub(crate) async fn native_automatic_backup_inspect_file(
    app: AppHandle,
    root_id: String,
    lease_token: String,
    request: AutomaticBackupFileRequest,
) -> Result<AutomaticBackupFileInspection, CommandError> {
    // Inspection shares the same large file-verification future as creation.
    Box::pin(native_automatic_backup_inspect_file_inner(
        app,
        root_id,
        lease_token,
        request,
    ))
    .await
}

async fn native_automatic_backup_inspect_file_inner(
    app: AppHandle,
    root_id: String,
    lease_token: String,
    request: AutomaticBackupFileRequest,
) -> Result<AutomaticBackupFileInspection, CommandError> {
    let root = resolve_checked_root(&app, &root_id)?;
    require_lease(&root, &lease_token, unix_time_millis()?)?;
    let expected_status = request.status.as_deref().unwrap_or("creating");
    require_manifest_entry(&root, &request, expected_status)?;
    if matches!(
        expected_status,
        "creating" | "writing" | "verifying" | "unknown"
    ) {
        let source = app
            .path()
            .app_config_dir()
            .map_err(|_| file_safety_failed())?
            .join(DATABASE_FILE_NAME);
        return Box::pin(inspect_recoverable_backup(&source, &root, &request)).await;
    }
    Box::pin(inspect_backup_file(&root, &request)).await
}

#[tauri::command]
pub(crate) async fn native_automatic_backup_delete_file(
    app: AppHandle,
    root_id: String,
    lease_token: String,
    request: AutomaticBackupFileRequest,
) -> Result<&'static str, CommandError> {
    Box::pin(native_automatic_backup_delete_file_inner(
        app,
        root_id,
        lease_token,
        request,
    ))
    .await
}

async fn native_automatic_backup_delete_file_inner(
    app: AppHandle,
    root_id: String,
    lease_token: String,
    request: AutomaticBackupFileRequest,
) -> Result<&'static str, CommandError> {
    let root = resolve_checked_root(&app, &root_id)?;
    require_lease(&root, &lease_token, unix_time_millis()?)?;
    require_manifest_entry(&root, &request, "succeeded")?;
    Box::pin(delete_ready_file(&root, &request)).await
}

fn resolve_checked_root(app: &AppHandle, root_id: &str) -> Result<ManagedRoot, CommandError> {
    let base = app.path().app_data_dir().map_err(|_| root_unavailable())?;
    let root = resolve_managed_root(&base)?;
    if root.marker.root_id != root_id {
        return Err(root_untrusted());
    }
    Ok(root)
}

fn resolve_managed_root(base: &Path) -> Result<ManagedRoot, CommandError> {
    fs::create_dir_all(base).map_err(|_| root_unavailable())?;
    let canonical_base = base.canonicalize().map_err(|_| root_unavailable())?;
    ensure_directory(&canonical_base)?;
    let automatic = ensure_direct_child_directory(&canonical_base, AUTOMATIC_BACKUP_DIRECTORY)?;
    let root_path = ensure_direct_child_directory(&automatic, AUTOMATIC_BACKUP_VERSION_DIRECTORY)?;
    let marker_path = root_path.join(ROOT_MARKER_FILE);
    let marker = match read_json_file::<OwnershipMarker>(&marker_path) {
        Ok(marker) => marker,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let marker = OwnershipMarker {
                product: "InkShadow".to_owned(),
                purpose: "automatic_backups".to_owned(),
                schema_version: 1,
                root_id: format!("root-{}", random_token()),
            };
            match create_json_file(&marker_path, &marker) {
                Ok(()) => marker,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    read_json_file::<OwnershipMarker>(&marker_path).map_err(|_| root_untrusted())?
                }
                Err(_) => return Err(root_unavailable()),
            }
        }
        Err(_) => return Err(root_untrusted()),
    };
    if marker.product != "InkShadow"
        || marker.purpose != "automatic_backups"
        || marker.schema_version != 1
        || !valid_root_id(&marker.root_id)
    {
        return Err(root_untrusted());
    }
    let canonical_root = root_path.canonicalize().map_err(|_| root_untrusted())?;
    if !same_file::is_same_file(&root_path, &canonical_root).unwrap_or(false) {
        return Err(root_untrusted());
    }
    let absolute_path = normalized_absolute_path(&canonical_root)?;
    Ok(ManagedRoot {
        path: canonical_root,
        absolute_path,
        marker,
    })
}

fn root_inspection(root: &ManagedRoot) -> AutomaticBackupRootInspection {
    AutomaticBackupRootInspection {
        absolute_path: root.absolute_path.clone(),
        canonical_absolute_path: root.absolute_path.clone(),
        ownership_marker: root.marker.clone(),
    }
}

fn ensure_direct_child_directory(parent: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let child = parent.join(name);
    match fs::create_dir(&child) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(root_unavailable()),
    }
    ensure_directory(&child)?;
    let canonical = child.canonicalize().map_err(|_| root_untrusted())?;
    let canonical_parent = canonical.parent().ok_or_else(root_untrusted)?;
    if !same_file::is_same_file(parent, canonical_parent).unwrap_or(false)
        || canonical.file_name() != Some(name.as_ref())
    {
        return Err(root_untrusted());
    }
    Ok(canonical)
}

fn ensure_directory(path: &Path) -> Result<(), CommandError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| root_unavailable())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata_is_reparse(&metadata) {
        return Err(root_untrusted());
    }
    Ok(())
}

fn acquire_lease_at(
    root: &ManagedRoot,
    owner_id: &str,
    duration_minutes: u64,
    now_ms: u64,
) -> Result<Option<LeaseReceipt>, CommandError> {
    acquire_lease_for_runtime_at(
        root,
        owner_id,
        automatic_backup_runtime_id(),
        duration_minutes,
        now_ms,
    )
}

fn acquire_lease_for_runtime_at(
    root: &ManagedRoot,
    owner_id: &str,
    runtime_id: &str,
    duration_minutes: u64,
    now_ms: u64,
) -> Result<Option<LeaseReceipt>, CommandError> {
    if !valid_token(runtime_id) {
        return Err(lease_invalid());
    }
    let duration_ms = duration_minutes
        .checked_mul(60_000)
        .ok_or_else(lease_invalid)?;
    let expires_unix_ms = now_ms.checked_add(duration_ms).ok_or_else(lease_invalid)?;
    let token = random_token();
    let claim = root
        .path
        .join(format!(".inkshadow-automatic-backup-lease-claim-{token}"));
    fs::create_dir(&claim).map_err(|_| lease_unavailable())?;
    let record = LeaseRecord {
        schema_version: 2,
        root_id: root.marker.root_id.clone(),
        token: token.clone(),
        owner_id: owner_id.to_owned(),
        runtime_id: Some(runtime_id.to_owned()),
        acquired_unix_ms: now_ms,
        expires_unix_ms,
    };
    if create_json_file(&claim.join(LEASE_RECORD_FILE), &record).is_err() {
        cleanup_lease_directory(&claim);
        return Err(lease_unavailable());
    }
    let active = root.path.join(LEASE_DIRECTORY);
    for _ in 0..4 {
        match fs::rename(&claim, &active) {
            Ok(()) => return Ok(Some(LeaseReceipt { token })),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied && active.exists() => {}
            Err(_) if active.exists() => {}
            Err(_) => {
                cleanup_lease_directory(&claim);
                return Err(lease_unavailable());
            }
        }
        let observed = read_lease_record(&active)?;
        let same_runtime = observed.runtime_id.as_deref() == Some(runtime_id);
        // The desktop bootstrap is single-instance. A different runtime id
        // therefore identifies a crash-orphaned lease from an earlier native
        // process, while another owner in this live process must remain busy.
        if same_runtime && observed.expires_unix_ms > now_ms {
            cleanup_lease_directory(&claim);
            return Ok(None);
        }
        let retired = root
            .path
            .join(format!(".inkshadow-automatic-backup-lease-retired-{token}"));
        if fs::rename(&active, &retired).is_err() {
            continue;
        }
        let moved = read_lease_record(&retired)?;
        if moved.token != observed.token
            || (moved.runtime_id.as_deref() == Some(runtime_id) && moved.expires_unix_ms > now_ms)
        {
            let _ = fs::rename(&retired, &active);
            cleanup_lease_directory(&claim);
            return Ok(None);
        }
        cleanup_lease_directory(&retired);
    }
    cleanup_lease_directory(&claim);
    Ok(None)
}

fn require_lease(root: &ManagedRoot, token: &str, now_ms: u64) -> Result<(), CommandError> {
    if !valid_token(token) {
        return Err(lease_invalid());
    }
    let record = read_lease_record(&root.path.join(LEASE_DIRECTORY))?;
    if !matches!(record.schema_version, 1 | 2)
        || record.root_id != root.marker.root_id
        || record.token != token
        || record.expires_unix_ms <= now_ms
    {
        return Err(lease_invalid());
    }
    Ok(())
}

fn release_lease(root: &ManagedRoot, token: &str) -> Result<(), CommandError> {
    if !valid_token(token) {
        return Err(lease_invalid());
    }
    let active = root.path.join(LEASE_DIRECTORY);
    let release = root
        .path
        .join(format!(".inkshadow-automatic-backup-lease-release-{token}"));
    match fs::rename(&active, &release) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(lease_unavailable()),
    }
    let record = read_lease_record(&release)?;
    if record.token != token || record.root_id != root.marker.root_id {
        let _ = fs::rename(&release, &active);
        return Err(lease_invalid());
    }
    cleanup_lease_directory(&release);
    Ok(())
}

fn read_lease_record(directory: &Path) -> Result<LeaseRecord, CommandError> {
    let record = read_json_file::<LeaseRecord>(&directory.join(LEASE_RECORD_FILE))
        .map_err(|_| lease_invalid())?;
    let runtime_valid = match record.schema_version {
        1 => record.runtime_id.is_none(),
        2 => record.runtime_id.as_deref().is_some_and(valid_token),
        _ => false,
    };
    if !runtime_valid
        || !valid_root_id(&record.root_id)
        || !valid_token(&record.token)
        || !valid_uuid_v7(&record.owner_id)
        || record.expires_unix_ms <= record.acquired_unix_ms
    {
        return Err(lease_invalid());
    }
    Ok(record)
}

fn automatic_backup_runtime_id() -> &'static str {
    AUTOMATIC_BACKUP_RUNTIME_ID
        .get_or_init(random_token)
        .as_str()
}

fn cleanup_lease_directory(directory: &Path) {
    let _ = fs::remove_file(directory.join(LEASE_RECORD_FILE));
    let _ = fs::remove_dir(directory);
}

fn read_manifest(root: &ManagedRoot) -> Result<Option<JsonValue>, CommandError> {
    for (file_name, schema_version) in [(MANIFEST_FILE_V2, 2), (MANIFEST_FILE_V1, 1)] {
        match read_json_file::<JsonValue>(&root.path.join(file_name)) {
            Ok(value) => {
                validate_manifest_shape(&value, &root.marker.root_id, None, Some(schema_version))?;
                return Ok(Some(value));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(manifest_invalid()),
        }
    }
    Ok(None)
}

fn write_manifest(
    root: &ManagedRoot,
    lease_token: &str,
    expected_revision: u64,
    manifest: &JsonValue,
) -> Result<(), CommandError> {
    validate_manifest_shape(
        manifest,
        &root.marker.root_id,
        Some(expected_revision.saturating_add(1)),
        Some(2),
    )?;
    let current_revision = match read_manifest(root)? {
        Some(value) => value
            .get("revision")
            .and_then(JsonValue::as_u64)
            .ok_or_else(manifest_invalid)?,
        None => 0,
    };
    if current_revision != expected_revision {
        return Err(manifest_conflict());
    }
    let bytes = serde_json::to_vec(manifest).map_err(|_| manifest_invalid())?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err(manifest_invalid());
    }
    let temporary = root.path.join(format!(
        ".inkshadow-automatic-backup-manifest-{lease_token}.tmp"
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| manifest_commit_failed())?;
    let write_result = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(manifest_commit_failed());
    }
    if atomic_replace(&temporary, &root.path.join(MANIFEST_FILE_V2)).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(manifest_commit_failed());
    }
    Ok(())
}

fn validate_manifest_shape(
    value: &JsonValue,
    root_id: &str,
    expected_revision: Option<u64>,
    expected_schema_version: Option<u64>,
) -> Result<(), CommandError> {
    let object = value.as_object().ok_or_else(manifest_invalid)?;
    let expected_keys = [
        "schemaVersion",
        "rootId",
        "revision",
        "policy",
        "lastSuccessfulSlot",
        "entries",
        "updatedAt",
    ];
    if object.len() != expected_keys.len()
        || expected_keys.iter().any(|key| !object.contains_key(*key))
        || !matches!(
            object.get("schemaVersion").and_then(JsonValue::as_u64),
            Some(1 | 2)
        )
        || expected_schema_version.is_some_and(|schema_version| {
            object.get("schemaVersion").and_then(JsonValue::as_u64) != Some(schema_version)
        })
        || object.get("rootId").and_then(JsonValue::as_str) != Some(root_id)
        || expected_revision.is_some_and(|revision| {
            object.get("revision").and_then(JsonValue::as_u64) != Some(revision)
        })
        || object.get("revision").and_then(JsonValue::as_u64).is_none()
        || object
            .get("policy")
            .and_then(JsonValue::as_object)
            .is_none()
        || object
            .get("updatedAt")
            .and_then(JsonValue::as_str)
            .is_none()
    {
        return Err(manifest_invalid());
    }
    let entries = object
        .get("entries")
        .and_then(JsonValue::as_array)
        .ok_or_else(manifest_invalid)?;
    if entries.len() > MAX_MANIFEST_ENTRIES {
        return Err(manifest_invalid());
    }
    Ok(())
}

fn require_manifest_entry(
    root: &ManagedRoot,
    request: &AutomaticBackupFileRequest,
    expected_status: &str,
) -> Result<(), CommandError> {
    let manifest = read_manifest(root)?.ok_or_else(manifest_invalid)?;
    let entries = manifest
        .get("entries")
        .and_then(JsonValue::as_array)
        .ok_or_else(manifest_invalid)?;
    let matching = entries.iter().filter(|entry| {
        let identity_matches = entry.get("backupId").and_then(JsonValue::as_str)
            == Some(request.backup_id.as_str())
            && entry.get("createdBy").and_then(JsonValue::as_str)
                == Some("inkshadow_automatic_backup_service")
            && entry.get("fileName").and_then(JsonValue::as_str)
                == Some(request.file_name.as_str())
            && entry.get("absolutePath").and_then(JsonValue::as_str)
                == Some(request.absolute_path.as_str())
            && entry.get("status").and_then(JsonValue::as_str) == Some(expected_status);
        let integrity_matches = if matches!(expected_status, "ready" | "verifying" | "succeeded")
            || (expected_status == "unknown" && request.byte_length.is_some())
        {
            entry.get("byteLength").and_then(JsonValue::as_u64) == request.byte_length
                && entry.get("sha256").and_then(JsonValue::as_str) == request.sha256.as_deref()
        } else {
            entry.get("byteLength").is_some_and(JsonValue::is_null)
                && entry.get("sha256").is_some_and(JsonValue::is_null)
        };
        let retention_matches = request.retention_until.as_deref().is_none_or(|retention| {
            entry.get("retentionUntil").and_then(JsonValue::as_str) == Some(retention)
        });
        identity_matches && integrity_matches && retention_matches
    });
    if matching.count() != 1 {
        return Err(manifest_invalid());
    }
    Ok(())
}

fn validate_file_request(
    root: &ManagedRoot,
    request: &AutomaticBackupFileRequest,
) -> Result<PathBuf, CommandError> {
    if !valid_uuid_v7(&request.backup_id)
        || !valid_automatic_backup_file_name(&request.file_name, &request.backup_id)
        || request.absolute_path != format!("{}/{}", root.absolute_path, request.file_name)
    {
        return Err(file_safety_failed());
    }
    let path = root.path.join(&request.file_name);
    if path.parent() != Some(root.path.as_path()) {
        return Err(file_safety_failed());
    }
    Ok(path)
}

async fn create_verified_backup(
    source: &Path,
    root: &ManagedRoot,
    request: &AutomaticBackupFileRequest,
) -> AutomaticBackupCreationOutcome {
    if let Err(error) = safe_regular_file_identity(source) {
        return AutomaticBackupCreationOutcome::NotStarted {
            failure_kind: classify_io_failure(&error, "database_unavailable"),
        };
    }

    let destination = match validate_file_request(root, request) {
        Ok(path) => path,
        Err(_) => {
            return AutomaticBackupCreationOutcome::NotStarted {
                failure_kind: "target_conflict",
            }
        }
    };
    match fs::symlink_metadata(&destination) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Ok(_) => {
            return AutomaticBackupCreationOutcome::NotStarted {
                failure_kind: "target_conflict",
            }
        }
        Err(error) => {
            return AutomaticBackupCreationOutcome::NotStarted {
                failure_kind: classify_io_failure(&error, "write_failed"),
            }
        }
    }

    // SQLite writes into a unique sibling first. A verified inode is installed
    // with a no-overwrite hard link, so the final filename is never partially
    // populated and a competing target can never be replaced.
    let temporary = automatic_backup_temporary_path(root, request);
    match fs::symlink_metadata(&temporary) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Ok(_) => {
            return AutomaticBackupCreationOutcome::NotStarted {
                failure_kind: "target_conflict",
            }
        }
        Err(error) => {
            return AutomaticBackupCreationOutcome::NotStarted {
                failure_kind: classify_io_failure(&error, "write_failed"),
            }
        }
    }

    let options = SqliteConnectOptions::new()
        .filename(source)
        .create_if_missing(false)
        .busy_timeout(DATABASE_BUSY_TIMEOUT);
    let mut source_connection = match SqliteConnection::connect_with(&options).await {
        Ok(connection) => connection,
        Err(error) => {
            return AutomaticBackupCreationOutcome::NotStarted {
                failure_kind: classify_sqlite_failure(&error, false),
            }
        }
    };
    if verify_open_sqlite_integrity(&mut source_connection)
        .await
        .is_err()
    {
        let _ = source_connection.close().await;
        return AutomaticBackupCreationOutcome::NotStarted {
            failure_kind: "database_unavailable",
        };
    }
    let source_schema = match read_sqlite_schema(&mut source_connection).await {
        Ok(schema) => schema,
        Err(error) => {
            let failure_kind = classify_sqlite_failure(&error, false);
            let _ = source_connection.close().await;
            return AutomaticBackupCreationOutcome::NotStarted { failure_kind };
        }
    };

    let temporary_path = temporary.to_string_lossy().into_owned();
    let vacuum = sqlx::query("VACUUM INTO ?")
        .bind(temporary_path)
        .execute(&mut source_connection)
        .await;
    let _ = source_connection.close().await;
    if let Err(error) = vacuum {
        return AutomaticBackupCreationOutcome::Failed {
            failure_kind: classify_sqlite_failure(&error, true),
        };
    }

    let temporary_schema = match read_sqlite_schema_file(&temporary).await {
        Ok(schema) => schema,
        Err(_) => {
            return AutomaticBackupCreationOutcome::Failed {
                failure_kind: "verification_failed",
            }
        }
    };
    if temporary_schema != source_schema || verify_sqlite_integrity(&temporary).await.is_err() {
        return AutomaticBackupCreationOutcome::Failed {
            failure_kind: "verification_failed",
        };
    }
    if OpenOptions::new()
        .read(true)
        .write(true)
        .open(&temporary)
        .and_then(|file| file.sync_all())
        .is_err()
    {
        return AutomaticBackupCreationOutcome::Failed {
            failure_kind: "write_failed",
        };
    }

    match fs::hard_link(&temporary, &destination) {
        Ok(()) => {}
        Err(error) => {
            let failure_kind = if destination.exists() {
                "target_conflict"
            } else {
                classify_io_failure(&error, "write_failed")
            };
            return AutomaticBackupCreationOutcome::Failed { failure_kind };
        }
    }
    let outcome = confirm_installed_backup(root, request).await;
    if matches!(outcome, AutomaticBackupCreationOutcome::Succeeded { .. })
        && cleanup_verified_temporary_link(root, request, &destination).is_err()
    {
        return AutomaticBackupCreationOutcome::Unknown {
            failure_kind: "result_unconfirmed",
        };
    }
    outcome
}

fn automatic_backup_temporary_path(
    root: &ManagedRoot,
    request: &AutomaticBackupFileRequest,
) -> PathBuf {
    root.path.join(format!(
        ".inkshadow-auto-write-{}.sqlite3",
        request.backup_id
    ))
}

fn cleanup_verified_temporary_link(
    root: &ManagedRoot,
    request: &AutomaticBackupFileRequest,
    destination: &Path,
) -> Result<(), CommandError> {
    let temporary = automatic_backup_temporary_path(root, request);
    let temporary_identity = match safe_regular_file_identity(&temporary) {
        Ok(identity) => identity,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(file_safety_failed()),
    };
    let destination_identity =
        safe_regular_file_identity(destination).map_err(|_| file_safety_failed())?;
    if temporary_identity != destination_identity {
        return Err(file_safety_failed());
    }
    fs::remove_file(temporary).map_err(|_| file_safety_failed())
}

async fn confirm_installed_backup(
    root: &ManagedRoot,
    request: &AutomaticBackupFileRequest,
) -> AutomaticBackupCreationOutcome {
    let destination = match validate_file_request(root, request) {
        Ok(path) => path,
        Err(_) => {
            return AutomaticBackupCreationOutcome::Unknown {
                failure_kind: "result_unconfirmed",
            }
        }
    };
    if OpenOptions::new()
        .read(true)
        .write(true)
        .open(destination)
        .and_then(|file| file.sync_all())
        .is_err()
    {
        return AutomaticBackupCreationOutcome::Unknown {
            failure_kind: "result_unconfirmed",
        };
    }
    match inspect_backup_file(root, request).await {
        Ok(file @ AutomaticBackupFileInspection::Present { .. }) => {
            AutomaticBackupCreationOutcome::Succeeded { file }
        }
        Ok(AutomaticBackupFileInspection::Missing { .. }) | Err(_) => {
            AutomaticBackupCreationOutcome::Unknown {
                failure_kind: "result_unconfirmed",
            }
        }
    }
}

async fn verify_open_sqlite_integrity(
    connection: &mut SqliteConnection,
) -> Result<(), sqlx::Error> {
    let integrity = sqlx::query("PRAGMA integrity_check(100)")
        .fetch_all(&mut *connection)
        .await?;
    let foreign_keys = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *connection)
        .await?;
    if integrity.len() == 1
        && integrity[0].try_get::<String, _>(0).ok().as_deref() == Some("ok")
        && foreign_keys.is_empty()
    {
        Ok(())
    } else {
        Err(sqlx::Error::Protocol(
            "SQLite integrity verification failed".to_owned(),
        ))
    }
}

async fn read_sqlite_schema(connection: &mut SqliteConnection) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>(
        "SELECT type || char(31) || name || char(31) || tbl_name || char(31) || COALESCE(sql, '') \
         FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .fetch_all(connection)
    .await
}

async fn read_sqlite_schema_file(path: &Path) -> Result<Vec<String>, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(DATABASE_BUSY_TIMEOUT);
    let mut connection = SqliteConnection::connect_with(&options).await?;
    let schema = read_sqlite_schema(&mut connection).await;
    let _ = connection.close().await;
    schema
}

async fn verify_backup_schema_matches_source(
    source: &Path,
    backup: &Path,
) -> Result<(), CommandError> {
    safe_regular_file_identity(source).map_err(|_| file_safety_failed())?;
    safe_regular_file_identity(backup).map_err(|_| file_safety_failed())?;
    let source_schema = read_sqlite_schema_file(source)
        .await
        .map_err(|_| file_safety_failed())?;
    let backup_schema = read_sqlite_schema_file(backup)
        .await
        .map_err(|_| file_safety_failed())?;
    if source_schema != backup_schema {
        return Err(file_safety_failed());
    }
    Ok(())
}

async fn inspect_recoverable_backup(
    source: &Path,
    root: &ManagedRoot,
    request: &AutomaticBackupFileRequest,
) -> Result<AutomaticBackupFileInspection, CommandError> {
    let inspection = inspect_backup_file(root, request).await?;
    let AutomaticBackupFileInspection::Present {
        byte_length,
        sha256,
        ..
    } = &inspection
    else {
        return Ok(inspection);
    };
    if request
        .byte_length
        .is_some_and(|expected| expected != *byte_length)
        || request
            .sha256
            .as_deref()
            .is_some_and(|expected| expected != sha256)
    {
        return Err(file_safety_failed());
    }
    let destination = validate_file_request(root, request)?;
    verify_backup_schema_matches_source(source, &destination).await?;
    cleanup_verified_temporary_link(root, request, &destination)?;
    Ok(inspection)
}

fn classify_sqlite_failure(error: &sqlx::Error, write_started: bool) -> &'static str {
    let primary_code = match error {
        sqlx::Error::Database(database) => database
            .code()
            .and_then(|code| code.parse::<u32>().ok())
            .map(|code| code & 0xff),
        _ => None,
    };
    match primary_code {
        Some(5 | 6) => "database_busy",
        Some(13) => "disk_full",
        Some(3 | 8) => "permission_denied",
        Some(14) => "database_unavailable",
        Some(10) if write_started => "write_failed",
        _ if write_started => "write_failed",
        _ => "database_unavailable",
    }
}

fn classify_io_failure(error: &io::Error, fallback: &'static str) -> &'static str {
    if error.kind() == io::ErrorKind::PermissionDenied {
        "permission_denied"
    } else if matches!(error.raw_os_error(), Some(28 | 112)) {
        "disk_full"
    } else if error.kind() == io::ErrorKind::AlreadyExists {
        "target_conflict"
    } else {
        fallback
    }
}

async fn inspect_backup_file(
    root: &ManagedRoot,
    request: &AutomaticBackupFileRequest,
) -> Result<AutomaticBackupFileInspection, CommandError> {
    let path = validate_file_request(root, request)?;
    let initial_identity = match safe_regular_file_identity(&path) {
        Ok(identity) => identity,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(AutomaticBackupFileInspection::Missing { exists: false })
        }
        Err(_) => return Err(file_safety_failed()),
    };
    let metadata = fs::metadata(&path).map_err(|_| file_safety_failed())?;
    if metadata.len() == 0 || metadata.len() > MAX_SAFE_JS_INTEGER {
        return Err(file_safety_failed());
    }
    let sha256 = hash_file(&path).await?;
    verify_sqlite_integrity(&path).await?;
    let final_identity = safe_regular_file_identity(&path).map_err(|_| file_safety_failed())?;
    if initial_identity != final_identity {
        return Err(file_safety_failed());
    }
    let canonical = path.canonicalize().map_err(|_| file_safety_failed())?;
    if canonical.parent() != Some(root.path.as_path())
        || canonical.file_name() != Some(request.file_name.as_ref())
    {
        return Err(file_safety_failed());
    }
    Ok(AutomaticBackupFileInspection::Present {
        exists: true,
        file_name: request.file_name.clone(),
        absolute_path: request.absolute_path.clone(),
        canonical_absolute_path: normalized_absolute_path(&canonical)?,
        byte_length: metadata.len(),
        sha256,
        integrity_verified: true,
    })
}

async fn delete_ready_file(
    root: &ManagedRoot,
    request: &AutomaticBackupFileRequest,
) -> Result<&'static str, CommandError> {
    if request.status.as_deref() != Some("succeeded")
        || request.byte_length.is_none()
        || request
            .sha256
            .as_deref()
            .is_none_or(|value| !valid_sha256(value))
        || !request
            .retention_until
            .as_deref()
            .is_some_and(retention_has_expired)
    {
        return Err(file_safety_failed());
    }
    let inspection = inspect_backup_file(root, request).await?;
    let (byte_length, sha256) = match inspection {
        AutomaticBackupFileInspection::Missing { .. } => return Ok("already_missing"),
        AutomaticBackupFileInspection::Present {
            byte_length,
            sha256,
            ..
        } => (byte_length, sha256),
    };
    if Some(byte_length) != request.byte_length
        || Some(sha256.as_str()) != request.sha256.as_deref()
    {
        return Err(file_safety_failed());
    }
    let path = validate_file_request(root, request)?;
    let expected_identity = safe_regular_file_identity(&path).map_err(|_| file_safety_failed())?;
    let final_metadata = fs::metadata(&path).map_err(|_| file_safety_failed())?;
    let final_hash = hash_file(&path).await?;
    let current_identity = safe_regular_file_identity(&path).map_err(|_| file_safety_failed())?;
    if expected_identity != current_identity
        || Some(final_metadata.len()) != request.byte_length
        || Some(final_hash.as_str()) != request.sha256.as_deref()
    {
        return Err(file_safety_failed());
    }
    fs::remove_file(path).map_err(|_| file_safety_failed())?;
    Ok("deleted")
}

fn safe_regular_file_identity(path: &Path) -> io::Result<Handle> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata_is_reparse(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsafe file identity",
        ));
    }
    Handle::from_path(path)
}

async fn hash_file(path: &Path) -> Result<String, CommandError> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| file_safety_failed())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|_| file_safety_failed())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn verify_sqlite_integrity(path: &Path) -> Result<(), CommandError> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| file_safety_failed())?;
    let integrity = sqlx::query("PRAGMA integrity_check(100)")
        .fetch_all(&mut connection)
        .await
        .map_err(|_| file_safety_failed())?;
    let foreign_keys = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut connection)
        .await
        .map_err(|_| file_safety_failed())?;
    let healthy = integrity.len() == 1
        && integrity[0].try_get::<String, _>(0).ok().as_deref() == Some("ok")
        && foreign_keys.is_empty();
    let _ = connection.close().await;
    if !healthy {
        return Err(file_safety_failed());
    }
    Ok(())
}

fn read_json_file<Value: for<'de> Deserialize<'de>>(path: &Path) -> io::Result<Value> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse(&metadata)
        || metadata.len() > MAX_METADATA_BYTES
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsafe metadata file",
        ));
    }
    let initial = Handle::from_path(path)?;
    let bytes = fs::read(path)?;
    let final_identity = Handle::from_path(path)?;
    if initial != final_identity || bytes.len() as u64 != metadata.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "metadata changed",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid metadata"))
}

fn create_json_file<Value: Serialize>(path: &Path, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid metadata"))?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "metadata too large",
        ));
    }
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & REPARSE_POINT_ATTRIBUTE != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

fn normalized_absolute_path(path: &Path) -> Result<String, CommandError> {
    if !path.is_absolute() {
        return Err(root_untrusted());
    }
    let mut value = path.to_string_lossy().replace('\\', "/");
    if let Some(stripped) = value.strip_prefix("//?/UNC/") {
        value = format!("//{stripped}");
    } else if let Some(stripped) = value.strip_prefix("//?/") {
        value = stripped.to_owned();
    }
    if value.starts_with("//") || value.contains("//") || value.ends_with('/') {
        return Err(root_untrusted());
    }
    Ok(value)
}

fn valid_automatic_backup_file_name(file_name: &str, backup_id: &str) -> bool {
    const PREFIX: &str = "inkshadow-auto-v1-";
    const SUFFIX: &str = ".sqlite3";
    let Some(body) = file_name
        .strip_prefix(PREFIX)
        .and_then(|value| value.strip_suffix(SUFFIX))
    else {
        return false;
    };
    let Some((timestamp, identifier)) = body.split_once('-') else {
        return false;
    };
    timestamp.len() == 19
        && timestamp.as_bytes().get(8) == Some(&b'T')
        && timestamp.as_bytes().get(18) == Some(&b'Z')
        && timestamp
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 8 || index == 18 || byte.is_ascii_digit())
        && identifier == backup_id
        && valid_uuid_v7(identifier)
}

fn valid_uuid_v7(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|uuid| {
        uuid.get_version_num() == 7
            && uuid.get_variant() == Variant::RFC4122
            && uuid.to_string() == value
    })
}

fn valid_root_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn retention_has_expired(value: &str) -> bool {
    value.len() == 24
        && value.ends_with('Z')
        && OffsetDateTime::parse(value, &Rfc3339)
            .is_ok_and(|retention| retention <= OffsetDateTime::now_utc())
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unix_time_millis() -> Result<u64, CommandError> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| lease_unavailable())?
        .as_millis();
    u64::try_from(milliseconds).map_err(|_| lease_unavailable())
}

fn root_unavailable() -> CommandError {
    CommandError::new(
        "AUTOMATIC_BACKUP_ROOT_UNAVAILABLE",
        "The managed automatic-backup directory is unavailable.",
        true,
        vec!["RETRY", "OPEN_DIAGNOSTICS"],
    )
}

fn root_untrusted() -> CommandError {
    CommandError::new(
        "AUTOMATIC_BACKUP_ROOT_UNTRUSTED",
        "The managed automatic-backup directory failed its ownership check.",
        false,
        vec!["OPEN_DIAGNOSTICS"],
    )
}

fn lease_invalid() -> CommandError {
    CommandError::new(
        "AUTOMATIC_BACKUP_LEASE_INVALID",
        "The automatic-backup lease is invalid or expired.",
        true,
        vec!["RETRY"],
    )
}

fn lease_unavailable() -> CommandError {
    CommandError::new(
        "AUTOMATIC_BACKUP_LEASE_UNAVAILABLE",
        "The automatic-backup lease could not be acquired safely.",
        true,
        vec!["RETRY"],
    )
}

fn manifest_invalid() -> CommandError {
    CommandError::new(
        "AUTOMATIC_BACKUP_MANIFEST_INVALID",
        "The automatic-backup manifest failed validation.",
        false,
        vec!["OPEN_DIAGNOSTICS"],
    )
}

fn manifest_conflict() -> CommandError {
    CommandError::new(
        "AUTOMATIC_BACKUP_MANIFEST_CONFLICT",
        "The automatic-backup manifest changed concurrently.",
        true,
        vec!["RETRY"],
    )
}

fn manifest_commit_failed() -> CommandError {
    CommandError::new(
        "AUTOMATIC_BACKUP_MANIFEST_COMMIT_FAILED",
        "The automatic-backup manifest could not be replaced atomically.",
        true,
        vec!["RETRY", "OPEN_DIAGNOSTICS"],
    )
}

fn file_safety_failed() -> CommandError {
    CommandError::new(
        "AUTOMATIC_BACKUP_FILE_SAFETY_CHECK_FAILED",
        "The automatic-backup file failed its ownership or integrity check.",
        false,
        vec!["OPEN_DIAGNOSTICS"],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create() -> Self {
            let path =
                std::env::temp_dir().join(format!("inkshadow-auto-backup-{}", random_token()));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_a_stable_owned_root_and_rejects_parallel_lease_owners() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let reopened = resolve_managed_root(&directory.0).expect("reopened root");
        assert_eq!(root.marker.root_id, reopened.marker.root_id);

        let first = acquire_lease_at(&root, "019f9f4a-b3c7-7350-9226-000000000001", 120, 1_000)
            .expect("first lease")
            .expect("available");
        let busy = acquire_lease_at(&root, "019f9f4a-b3c7-7350-9226-000000000002", 120, 2_000)
            .expect("busy result");
        assert!(busy.is_none());
        release_lease(&root, &first.token).expect("release");
    }

    #[test]
    fn takes_over_only_an_expired_lease() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        acquire_lease_at(&root, "019f9f4a-b3c7-7350-9226-000000000001", 5, 1_000)
            .expect("first lease")
            .expect("available");
        let replacement =
            acquire_lease_at(&root, "019f9f4a-b3c7-7350-9226-000000000002", 5, 302_000)
                .expect("replacement")
                .expect("expired lease replaced");
        require_lease(&root, &replacement.token, 302_001).expect("replacement owns lease");
    }

    #[test]
    fn a_new_native_runtime_retires_an_unexpired_crash_orphaned_lease() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        acquire_lease_for_runtime_at(
            &root,
            "019f9f4a-b3c7-7350-9226-000000000001",
            &"a".repeat(64),
            120,
            1_000,
        )
        .expect("first lease")
        .expect("available");

        let replacement = acquire_lease_for_runtime_at(
            &root,
            "019f9f4a-b3c7-7350-9226-000000000002",
            &"b".repeat(64),
            120,
            2_000,
        )
        .expect("replacement")
        .expect("foreign runtime lease is orphaned");

        require_lease(&root, &replacement.token, 2_001).expect("replacement owns lease");
    }

    #[test]
    fn a_new_native_runtime_conservatively_takes_over_a_v1_lease() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let active = root.path.join(LEASE_DIRECTORY);
        fs::create_dir(&active).expect("legacy lease directory");
        create_json_file(
            &active.join(LEASE_RECORD_FILE),
            &LeaseRecord {
                schema_version: 1,
                root_id: root.marker.root_id.clone(),
                token: "c".repeat(64),
                owner_id: "019f9f4a-b3c7-7350-9226-000000000001".to_owned(),
                runtime_id: None,
                acquired_unix_ms: 1_000,
                expires_unix_ms: 7_201_000,
            },
        )
        .expect("legacy lease");

        let replacement = acquire_lease_for_runtime_at(
            &root,
            "019f9f4a-b3c7-7350-9226-000000000002",
            &"d".repeat(64),
            120,
            2_000,
        )
        .expect("replacement")
        .expect("legacy runtime is no longer live");

        require_lease(&root, &replacement.token, 2_001).expect("replacement owns lease");
    }

    #[test]
    fn manifest_compare_and_swap_preserves_the_last_committed_revision() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let manifest = test_manifest(&root, 1, Vec::new());
        write_manifest(&root, &"a".repeat(64), 0, &manifest).expect("first commit");
        assert_eq!(
            read_manifest(&root).expect("read").expect("manifest")["revision"],
            1
        );
        assert!(write_manifest(&root, &"b".repeat(64), 0, &manifest).is_err());
    }

    #[test]
    fn v2_manifest_supersedes_v1_without_deleting_legacy_evidence() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let mut legacy = test_manifest(&root, 17, Vec::new());
        legacy["schemaVersion"] = JsonValue::from(1);
        create_json_file(&root.path.join(MANIFEST_FILE_V1), &legacy).expect("legacy manifest");
        assert_eq!(
            read_manifest(&root)
                .expect("read legacy")
                .expect("manifest")["schemaVersion"],
            1
        );

        let current = test_manifest(&root, 18, Vec::new());
        write_manifest(&root, &"a".repeat(64), 17, &current).expect("upgrade manifest");

        assert!(root.path.join(MANIFEST_FILE_V1).exists());
        assert!(root.path.join(MANIFEST_FILE_V2).exists());
        assert_eq!(
            read_manifest(&root).expect("read v2").expect("manifest")["schemaVersion"],
            2
        );
    }

    #[tokio::test]
    async fn deletes_only_the_ready_manifest_file_and_leaves_manual_files_untouched() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let request = test_ready_request(&root);
        create_test_sqlite(&root.path.join(&request.file_name)).await;
        let inspection = inspect_backup_file(&root, &request).await.expect("inspect");
        let (byte_length, sha256) = match inspection {
            AutomaticBackupFileInspection::Present {
                byte_length,
                sha256,
                ..
            } => (byte_length, sha256),
            AutomaticBackupFileInspection::Missing { .. } => panic!("backup missing"),
        };
        let request = AutomaticBackupFileRequest {
            byte_length: Some(byte_length),
            sha256: Some(sha256),
            ..request
        };
        let manual = root.path.join("manual-backup.sqlite3");
        fs::write(&manual, b"manual").expect("manual backup");
        let manifest = test_manifest(&root, 1, vec![test_manifest_entry(&request)]);
        write_manifest(&root, &"a".repeat(64), 0, &manifest).expect("manifest");
        require_manifest_entry(&root, &request, "succeeded").expect("succeeded entry");

        assert_eq!(
            delete_ready_file(&root, &request).await.expect("delete"),
            "deleted"
        );
        assert!(!root.path.join(&request.file_name).exists());
        assert!(manual.exists());
    }

    #[tokio::test]
    async fn checksum_mismatch_never_deletes_the_managed_file() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let mut request = test_ready_request(&root);
        create_test_sqlite(&root.path.join(&request.file_name)).await;
        request.byte_length = Some(
            fs::metadata(root.path.join(&request.file_name))
                .unwrap()
                .len(),
        );
        request.sha256 = Some("0".repeat(64));
        assert!(delete_ready_file(&root, &request).await.is_err());
        assert!(root.path.join(&request.file_name).exists());
    }

    #[tokio::test]
    async fn non_expired_ready_backup_is_never_deleted() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let mut request = test_ready_request(&root);
        create_test_sqlite(&root.path.join(&request.file_name)).await;
        let inspection = inspect_backup_file(&root, &request).await.expect("inspect");
        let AutomaticBackupFileInspection::Present {
            byte_length,
            sha256,
            ..
        } = inspection
        else {
            panic!("backup missing");
        };
        request.byte_length = Some(byte_length);
        request.sha256 = Some(sha256);
        request.retention_until = Some("2999-01-31T04:00:00.000Z".to_owned());

        assert!(delete_ready_file(&root, &request).await.is_err());
        assert!(root.path.join(&request.file_name).exists());
    }

    #[test]
    fn ready_manifest_integrity_must_match_the_delete_request_exactly() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let mut request = test_ready_request(&root);
        request.byte_length = Some(4096);
        request.sha256 = Some("a".repeat(64));
        let mut entry = test_manifest_entry(&request);
        entry["sha256"] = JsonValue::String("b".repeat(64));
        let manifest = test_manifest(&root, 1, vec![entry]);
        write_manifest(&root, &"a".repeat(64), 0, &manifest).expect("manifest");

        assert!(require_manifest_entry(&root, &request, "succeeded").is_err());
    }

    #[tokio::test]
    async fn independent_backup_installs_only_a_verified_complete_target() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let source = directory.0.join(DATABASE_FILE_NAME);
        create_test_sqlite(&source).await;
        let request = test_writing_request(&root);

        let outcome = create_verified_backup(&source, &root, &request).await;

        let AutomaticBackupCreationOutcome::Succeeded { file } = outcome else {
            let temporary = automatic_backup_temporary_path(&root, &request);
            panic!(
                "expected a verified backup, received {outcome:?}; temporary={}, destination={}",
                temporary.exists(),
                root.path.join(&request.file_name).exists()
            );
        };
        assert!(matches!(
            file,
            AutomaticBackupFileInspection::Present {
                integrity_verified: true,
                ..
            }
        ));
        assert!(root.path.join(&request.file_name).is_file());
        assert!(source.is_file());
        assert!(read_sqlite_schema_file(&source).await.is_ok());
    }

    #[tokio::test]
    async fn succeeded_manifest_backup_restores_authored_hash_and_foreign_keys() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let source = directory.0.join(DATABASE_FILE_NAME);
        let expected_hash = create_authored_test_sqlite(&source).await;
        let request = test_writing_request(&root);

        let outcome = create_verified_backup(&source, &root, &request).await;
        let AutomaticBackupCreationOutcome::Succeeded {
            file:
                AutomaticBackupFileInspection::Present {
                    byte_length,
                    sha256,
                    ..
                },
        } = outcome
        else {
            panic!("expected a verified backup, received {outcome:?}");
        };
        let manifest = serde_json::json!({
            "schemaVersion": 2,
            "rootId": root.marker.root_id,
            "revision": 1,
            "policy": { "scheduleHourLocal": 3, "retentionDays": 30 },
            "lastSuccessfulSlot": "2026-08-08",
            "entries": [{
                "backupId": request.backup_id,
                "createdBy": "inkshadow_automatic_backup_service",
                "scheduleSlot": "2026-08-08",
                "fileName": request.file_name,
                "absolutePath": request.absolute_path,
                "createdAt": "2026-08-08T04:00:00.000Z",
                "retentionUntil": request.retention_until,
                "status": "succeeded",
                "byteLength": byte_length,
                "sha256": sha256,
                "writeStartedAt": "2026-08-08T04:00:00.000Z",
                "finishedAt": "2026-08-08T04:00:01.000Z",
                "failureKind": null
            }],
            "updatedAt": "2026-08-08T04:00:01.000Z"
        });
        write_manifest(&root, &"b".repeat(64), 0, &manifest).expect("succeeded manifest");
        assert_eq!(
            read_manifest(&root).expect("read").expect("manifest")["entries"][0]["status"],
            "succeeded"
        );

        let restore = directory.0.join("independent-restore.sqlite3");
        fs::copy(root.path.join(&request.file_name), &restore).expect("copy restore candidate");
        verify_sqlite_integrity(&restore)
            .await
            .expect("restored integrity and foreign keys");
        let options = SqliteConnectOptions::new()
            .filename(&restore)
            .read_only(true)
            .create_if_missing(false);
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .expect("open restored database");
        let row = sqlx::query(
            "SELECT body, body_hash FROM authored_versions WHERE version_id = 'version-1'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("restored authored version");
        let body: String = row.try_get("body").expect("body");
        let stored_hash: String = row.try_get("body_hash").expect("stored hash");
        let restored_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
        assert_eq!(stored_hash, expected_hash);
        assert_eq!(restored_hash, expected_hash);
        connection.close().await.expect("close restore");
    }

    #[tokio::test]
    async fn existing_target_is_not_overwritten_or_retried_as_a_write() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let source = directory.0.join(DATABASE_FILE_NAME);
        create_test_sqlite(&source).await;
        let request = test_writing_request(&root);
        let destination = root.path.join(&request.file_name);
        fs::write(&destination, b"existing backup evidence").expect("existing target");

        let outcome = create_verified_backup(&source, &root, &request).await;

        assert!(matches!(
            outcome,
            AutomaticBackupCreationOutcome::NotStarted {
                failure_kind: "target_conflict"
            }
        ));
        assert_eq!(
            fs::read(destination).expect("target remains"),
            b"existing backup evidence"
        );
    }

    #[tokio::test]
    async fn post_install_verification_failure_is_unknown_and_preserves_the_target() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let request = test_writing_request(&root);
        let destination = root.path.join(&request.file_name);
        fs::write(&destination, b"installed but unreadable as sqlite").expect("installed target");

        let outcome = confirm_installed_backup(&root, &request).await;

        assert!(matches!(
            outcome,
            AutomaticBackupCreationOutcome::Unknown {
                failure_kind: "result_unconfirmed"
            }
        ));
        assert!(destination.exists());
    }

    #[tokio::test]
    async fn restart_recovery_removes_only_the_matching_temporary_link_before_pruning() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let source = directory.0.join(DATABASE_FILE_NAME);
        create_authored_test_sqlite(&source).await;
        let mut writing_request = test_writing_request(&root);
        writing_request.retention_until = Some("2020-01-31T04:00:00.000Z".to_owned());

        let outcome = create_verified_backup(&source, &root, &writing_request).await;
        let AutomaticBackupCreationOutcome::Succeeded {
            file:
                AutomaticBackupFileInspection::Present {
                    byte_length,
                    sha256,
                    ..
                },
        } = outcome
        else {
            panic!("expected a verified backup, received {outcome:?}");
        };
        let destination = root.path.join(&writing_request.file_name);
        let temporary = automatic_backup_temporary_path(&root, &writing_request);
        assert!(!temporary.exists());

        // Simulate a process ending after the no-overwrite install but before
        // it can unlink the exact temporary hard link or settle the manifest.
        fs::hard_link(&destination, &temporary).expect("recreate installed temporary link");
        let unknown_request = AutomaticBackupFileRequest {
            status: Some("unknown".to_owned()),
            byte_length: Some(byte_length),
            sha256: Some(sha256.clone()),
            ..writing_request
        };
        let mut unknown_entry = test_manifest_entry(&unknown_request);
        unknown_entry["status"] = JsonValue::String("unknown".to_owned());
        unknown_entry["failureKind"] = JsonValue::String("result_unconfirmed".to_owned());
        let unknown_manifest = test_manifest(&root, 1, vec![unknown_entry]);
        write_manifest(&root, &"a".repeat(64), 0, &unknown_manifest).expect("unknown manifest");
        require_manifest_entry(&root, &unknown_request, "unknown").expect("unknown entry");

        let recovered = inspect_recoverable_backup(&source, &root, &unknown_request)
            .await
            .expect("strict restart verification");
        assert!(matches!(
            recovered,
            AutomaticBackupFileInspection::Present {
                byte_length: recovered_length,
                sha256: ref recovered_hash,
                ..
            } if recovered_length == byte_length && recovered_hash == &sha256
        ));
        assert!(destination.exists());
        assert!(!temporary.exists());

        let succeeded_request = AutomaticBackupFileRequest {
            status: Some("succeeded".to_owned()),
            ..unknown_request
        };
        let succeeded_manifest =
            test_manifest(&root, 2, vec![test_manifest_entry(&succeeded_request)]);
        write_manifest(&root, &"b".repeat(64), 1, &succeeded_manifest).expect("succeeded manifest");
        require_manifest_entry(&root, &succeeded_request, "succeeded").expect("succeeded entry");

        assert_eq!(
            delete_ready_file(&root, &succeeded_request)
                .await
                .expect("prune verified backup"),
            "deleted"
        );
        assert!(!destination.exists());
        assert!(!temporary.exists());
    }

    #[tokio::test]
    async fn recovery_never_deletes_an_unrelated_exact_temporary_file() {
        let directory = TestDirectory::create();
        let root = resolve_managed_root(&directory.0).expect("managed root");
        let source = directory.0.join(DATABASE_FILE_NAME);
        create_test_sqlite(&source).await;
        let request = test_writing_request(&root);
        let destination = root.path.join(&request.file_name);
        create_test_sqlite(&destination).await;
        let temporary = automatic_backup_temporary_path(&root, &request);
        create_test_sqlite(&temporary).await;

        assert!(inspect_recoverable_backup(&source, &root, &request)
            .await
            .is_err());
        assert!(destination.exists());
        assert!(temporary.exists());
    }

    #[test]
    fn permission_and_full_disk_errors_have_explicit_terminal_classifications() {
        assert_eq!(
            classify_io_failure(
                &io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
                "write_failed"
            ),
            "permission_denied"
        );
        assert_eq!(
            classify_io_failure(&io::Error::from_raw_os_error(112), "write_failed"),
            "disk_full"
        );
    }

    #[tokio::test]
    async fn recovery_rejects_an_integrity_valid_file_with_the_wrong_schema() {
        let directory = TestDirectory::create();
        let source = directory.0.join("source.sqlite3");
        let backup = directory.0.join("wrong-schema.sqlite3");
        create_authored_test_sqlite(&source).await;
        create_test_sqlite(&backup).await;

        assert!(verify_sqlite_integrity(&backup).await.is_ok());
        assert!(verify_backup_schema_matches_source(&source, &backup)
            .await
            .is_err());
        assert!(backup.exists());
    }

    async fn create_test_sqlite(path: &Path) {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .expect("open sqlite");
        sqlx::query("CREATE TABLE authored_content (id TEXT PRIMARY KEY, body TEXT NOT NULL)")
            .execute(&mut connection)
            .await
            .expect("create table");
        connection.close().await.expect("close sqlite");
    }

    async fn create_authored_test_sqlite(path: &Path) -> String {
        let body = "雨夜里，主角把唯一的手稿藏进旧书柜。";
        let body_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .expect("open authored sqlite");
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut connection)
            .await
            .expect("enable foreign keys");
        sqlx::query("CREATE TABLE projects (project_id TEXT PRIMARY KEY)")
            .execute(&mut connection)
            .await
            .expect("create projects");
        sqlx::query(
            "CREATE TABLE chapters (chapter_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id))",
        )
        .execute(&mut connection)
        .await
        .expect("create chapters");
        sqlx::query(
            "CREATE TABLE authored_versions (version_id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(chapter_id), body TEXT NOT NULL, body_hash TEXT NOT NULL)",
        )
        .execute(&mut connection)
        .await
        .expect("create authored versions");
        sqlx::query("INSERT INTO projects(project_id) VALUES ('project-1')")
            .execute(&mut connection)
            .await
            .expect("insert project");
        sqlx::query(
            "INSERT INTO chapters(chapter_id, project_id) VALUES ('chapter-1', 'project-1')",
        )
        .execute(&mut connection)
        .await
        .expect("insert chapter");
        sqlx::query(
            "INSERT INTO authored_versions(version_id, chapter_id, body, body_hash) VALUES ('version-1', 'chapter-1', ?, ?)",
        )
        .bind(body)
        .bind(&body_hash)
        .execute(&mut connection)
        .await
        .expect("insert authored version");
        connection.close().await.expect("close authored sqlite");
        body_hash
    }

    fn test_ready_request(root: &ManagedRoot) -> AutomaticBackupFileRequest {
        let backup_id = "019f9f4a-b3c7-7350-9226-000000000001".to_owned();
        let file_name = format!("inkshadow-auto-v1-20260808T040000000Z-{backup_id}.sqlite3");
        AutomaticBackupFileRequest {
            absolute_path: format!("{}/{file_name}", root.absolute_path),
            backup_id,
            file_name,
            status: Some("succeeded".to_owned()),
            byte_length: None,
            sha256: None,
            retention_until: Some("2020-01-31T04:00:00.000Z".to_owned()),
        }
    }

    fn test_writing_request(root: &ManagedRoot) -> AutomaticBackupFileRequest {
        AutomaticBackupFileRequest {
            status: Some("writing".to_owned()),
            retention_until: Some("2026-09-07T04:00:00.000Z".to_owned()),
            ..test_ready_request(root)
        }
    }

    fn test_manifest(root: &ManagedRoot, revision: u64, entries: Vec<JsonValue>) -> JsonValue {
        serde_json::json!({
            "schemaVersion": 2,
            "rootId": root.marker.root_id,
            "revision": revision,
            "policy": { "scheduleHourLocal": 3, "retentionDays": 30 },
            "lastSuccessfulSlot": null,
            "entries": entries,
            "updatedAt": "2026-08-08T04:00:00.000Z"
        })
    }

    fn test_manifest_entry(request: &AutomaticBackupFileRequest) -> JsonValue {
        serde_json::json!({
            "backupId": request.backup_id,
            "createdBy": "inkshadow_automatic_backup_service",
            "scheduleSlot": "2026-08-08",
            "fileName": request.file_name,
            "absolutePath": request.absolute_path,
            "createdAt": "2026-08-08T04:00:00.000Z",
            "retentionUntil": request.retention_until,
            "status": "succeeded",
            "byteLength": request.byte_length,
            "sha256": request.sha256,
            "writeStartedAt": "2026-08-08T04:00:00.000Z",
            "finishedAt": "2026-08-08T04:00:00.000Z",
            "failureKind": null
        })
    }
}
