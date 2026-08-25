use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
    time::{Duration, Instant},
};

use futures_util::TryStreamExt;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{
        SqliteConnectOptions, SqliteJournalMode, SqliteQueryResult, SqliteRow, SqliteSynchronous,
    },
    Column, Connection, Row, SqliteConnection, TypeInfo, ValueRef,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{Mutex, MutexGuard};

use crate::local_migrations::{run_local_migrations, LocalMigrationError};
use crate::path_tickets::{
    PathTicketError, PathTicketPurpose, PathTicketReceipt, PathTicketState, TicketedPathOperation,
};

const DATABASE_FILE_NAME: &str = "inkshadow.db";
const PRE_RESTORE_BACKUP_DIRECTORY: &str = "pre-restore-backups";
const PRE_RESTORE_BACKUP_VERSION_DIRECTORY: &str = "v1";
const MAX_SQL_BYTES: usize = 1_000_000;
const MAX_BIND_VALUES: usize = 16_000;
const MAX_BIND_BYTES: usize = 32 * 1024 * 1024;
const MAX_CELL_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESULT_BYTES: usize = 64 * 1024 * 1024;
const MAX_RESULT_ROWS: usize = 100_001;
const MAX_RESULT_COLUMNS: usize = 512;
const MAX_COLUMN_NAME_BYTES: usize = 256;
const MAX_DATABASE_FILE_PATH_BYTES: usize = 32_767;
const MAX_SAFE_JS_INTEGER: i64 = 9_007_199_254_740_991;
// These clocks measure gaps between completed bridge calls. A long-running SQL
// statement holds the mutex and cannot be rolled back underneath itself.
const TRANSACTION_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const TRANSACTION_MAX_LIFETIME: Duration = Duration::from_secs(5 * 60);
const BRIDGE_LOCK_TIMEOUT: Duration = Duration::from_secs(25);
const FOREGROUND_OPERATION_TIMEOUT: Duration = Duration::from_secs(25);
const MAINTENANCE_OPERATION_TIMEOUT: Duration = Duration::from_secs(9 * 60);
const CLOSE_OPERATION_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone)]
pub(crate) struct NativeSqliteState {
    inner: Arc<Mutex<NativeSqliteBridge>>,
    transaction_idle_timeout: Duration,
    transaction_max_lifetime: Duration,
    bridge_lock_timeout: Duration,
    foreground_operation_timeout: Duration,
    maintenance_operation_timeout: Duration,
    close_operation_timeout: Duration,
    runtime_id: Arc<str>,
    startup_reconciled: Arc<AtomicBool>,
}

impl Default for NativeSqliteState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(NativeSqliteBridge::default())),
            transaction_idle_timeout: TRANSACTION_IDLE_TIMEOUT,
            transaction_max_lifetime: TRANSACTION_MAX_LIFETIME,
            bridge_lock_timeout: BRIDGE_LOCK_TIMEOUT,
            foreground_operation_timeout: FOREGROUND_OPERATION_TIMEOUT,
            maintenance_operation_timeout: MAINTENANCE_OPERATION_TIMEOUT,
            close_operation_timeout: CLOSE_OPERATION_TIMEOUT,
            runtime_id: Arc::from(random_token()),
            startup_reconciled: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeProjectContextChapterAuthority {
    pub(crate) chapter_id: String,
    pub(crate) current_version_id: String,
    pub(crate) revision: i64,
    pub(crate) privacy_revision: i64,
    pub(crate) privacy_mode: String,
    pub(crate) status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeProjectContextPrivacyReceipt {
    pub(crate) schema_version: u8,
    pub(crate) project_id: String,
    pub(crate) fingerprint: String,
    pub(crate) active_chapter_count: usize,
    pub(crate) retained_chapter_count: usize,
    pub(crate) requires_verified_local: bool,
    pub(crate) chapters: Vec<NativeProjectContextChapterAuthority>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum NativeModelDispatchScope {
    NonProject {
        reason: NativeNonProjectDispatchReason,
    },
    ProjectContext {
        receipt: NativeProjectContextPrivacyReceipt,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeNonProjectDispatchReason {
    CreativeOpening,
    ConnectionProbe,
    NovelSkillEvaluation,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeModelInvocationDispatchLedger {
    pub(crate) invocation_id: String,
    pub(crate) task_snapshot: String,
    pub(crate) expected_revision: i64,
    pub(crate) connection_id: String,
    pub(crate) connection_revision: i64,
    pub(crate) catalog_entry_id: String,
    pub(crate) catalog_entry_revision: i64,
    pub(crate) provider_kind_snapshot: String,
    pub(crate) model_id_snapshot: String,
}

#[derive(Clone, Debug)]
pub(crate) struct NativeModelInvocationDispatchTarget {
    pub(crate) protocol: String,
    pub(crate) credential_provider_id: String,
    pub(crate) base_url: String,
    pub(crate) authentication_mode: String,
    pub(crate) credential_header_name: Option<String>,
    pub(crate) model_discovery_path: Option<String>,
    pub(crate) text_generation_path: Option<String>,
    pub(crate) embedding_path: Option<String>,
    pub(crate) request_timeout_ms: i64,
    pub(crate) model_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeModelInvocationDispatchReceipt {
    pub(crate) invocation_id: String,
    pub(crate) dispatched_at: String,
    pub(crate) revision: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ModelInvocationDispatchLedgerError {
    Invalid,
    Conflict,
    Busy,
    OutcomeUnknown,
    Unavailable,
}

fn valid_model_invocation_dispatch_target(target: &NativeModelInvocationDispatchTarget) -> bool {
    matches!(
        target.protocol.as_str(),
        "openai_compatible" | "ollama" | "anthropic" | "gemini"
    ) && matches!(
        target.authentication_mode.as_str(),
        "none" | "bearer_keyring" | "custom_header_keyring"
    ) && !target.credential_provider_id.is_empty()
        && target.credential_provider_id.len() <= 128
        && !target.base_url.is_empty()
        && target.base_url.len() <= 2_048
        && target.request_timeout_ms >= 1_000
        && target.request_timeout_ms <= 600_000
        && !target.model_id.is_empty()
        && target.model_id.len() <= 512
        && target
            .credential_header_name
            .as_ref()
            .is_none_or(|value| !value.is_empty() && value.len() <= 128)
        && target
            .model_discovery_path
            .as_ref()
            .is_none_or(|value| !value.is_empty() && value.len() <= 1_024)
        && target
            .text_generation_path
            .as_ref()
            .is_none_or(|value| !value.is_empty() && value.len() <= 1_024)
        && target
            .embedding_path
            .as_ref()
            .is_none_or(|value| !value.is_empty() && value.len() <= 1_024)
}

pub(crate) fn valid_model_invocation_dispatch_task(task: &str) -> bool {
    matches!(
        task,
        "idea_discussion"
            | "book_start_guidance"
            | "prose_generation"
            | "continuation"
            | "rewrite"
            | "polish"
            | "outline_planning"
            | "scene_breakdown"
            | "chapter_summary"
            | "long_memory_compression"
            | "character_extraction"
            | "world_extraction"
            | "contradiction_check"
            | "pov_check"
            | "character_voice_check"
            | "content_quality_check"
            | "what_if_simulation"
            | "translation"
            | "capability_probe"
    )
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectRemoteDispatchLease {
    pub(crate) lease_id: String,
    pub(crate) operation_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProjectRemoteDispatchLeaseError {
    AuthorityChanged,
    PrivateChapterLocalOnly,
    DatabaseBusy,
    DatabaseUnavailable,
}

impl NativeSqliteState {
    async fn lock_bridge(
        &self,
        stage: &'static str,
    ) -> Result<MutexGuard<'_, NativeSqliteBridge>, NativeSqliteError> {
        tokio::time::timeout(self.bridge_lock_timeout, self.inner.lock())
            .await
            .map_err(|_| NativeSqliteError::operation_timeout(stage, "not_started"))
    }

    #[cfg(test)]
    pub(crate) async fn test_open_migrated_database(
        &self,
        path: &Path,
    ) -> Result<(), NativeSqliteError> {
        self.inner.lock().await.open_file(path).await.map(|_| ())
    }

    #[cfg(test)]
    pub(crate) async fn test_execute_internal_sql(
        &self,
        query: &str,
    ) -> Result<(), NativeSqliteError> {
        sqlx::query(query)
            .execute(self.inner.lock().await.connection_mut()?)
            .await
            .map(|_| ())
            .map_err(NativeSqliteError::from_sqlx)
    }

    #[cfg(test)]
    pub(crate) fn test_with_foreground_operation_timeout(mut self, timeout: Duration) -> Self {
        self.foreground_operation_timeout = timeout;
        self
    }

    /// Commits a content-free text-invocation dispatch receipt at the native
    /// network boundary. Validation, credential loading and project privacy
    /// leasing happen before this write; provider I/O happens only after it
    /// succeeds.
    pub(crate) async fn mark_model_invocation_dispatched(
        &self,
        ledger: &NativeModelInvocationDispatchLedger,
        target: &NativeModelInvocationDispatchTarget,
    ) -> Result<NativeModelInvocationDispatchReceipt, ModelInvocationDispatchLedgerError> {
        let canonical_id = if ledger.task_snapshot == "capability_probe" {
            ledger
                .invocation_id
                .strip_prefix("capability-probe-invocation-")
                .unwrap_or(&ledger.invocation_id)
        } else {
            &ledger.invocation_id
        };
        if uuid::Uuid::parse_str(canonical_id).is_err()
            || !valid_model_invocation_dispatch_task(&ledger.task_snapshot)
            || ledger.expected_revision < 1
            || ledger.connection_revision < 1
            || ledger.catalog_entry_revision < 1
            || ledger.connection_id.is_empty()
            || ledger.connection_id.len() > 128
            || ledger.catalog_entry_id.is_empty()
            || ledger.catalog_entry_id.len() > 128
            || ledger.provider_kind_snapshot.is_empty()
            || ledger.provider_kind_snapshot.len() > 128
            || ledger.model_id_snapshot.is_empty()
            || ledger.model_id_snapshot.len() > 512
            || !valid_model_invocation_dispatch_target(target)
        {
            return Err(ModelInvocationDispatchLedgerError::Invalid);
        }
        let mut bridge = self
            .lock_bridge("model_invocation_dispatch_ledger")
            .await
            .map_err(|_| ModelInvocationDispatchLedgerError::Busy)?;
        bridge
            .require_no_transaction()
            .map_err(|_| ModelInvocationDispatchLedgerError::Busy)?;
        let write = tokio::time::timeout(self.foreground_operation_timeout, async {
            sqlx::query(
                "UPDATE model_invocation_facts
                 SET provider_dispatch_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     revision = revision + 1
                 WHERE id = ? AND task = ? AND status = 'running'
                   AND connection_id = ? AND catalog_entry_id = ?
                   AND provider_kind_snapshot = ? AND model_id_snapshot = ?
                   AND provider_dispatch_started_at IS NULL AND revision = ?
                   AND EXISTS (
                     SELECT 1
                     FROM model_provider_connections AS connection
                     INNER JOIN model_catalog_entries AS catalog
                       ON catalog.id = ? AND catalog.connection_id = connection.id
                     WHERE connection.id = ?
                       AND connection.revision = ?
                       AND connection.enabled = 1
                       AND connection.provider_kind = ?
                       AND connection.protocol = ?
                       AND connection.base_url = ?
                       AND connection.authentication_mode = ?
                       AND connection.credential_header_name IS ?
                       AND connection.model_discovery_path IS ?
                       AND connection.text_generation_path IS ?
                       AND connection.embedding_path IS ?
                       AND connection.request_timeout_ms = ?
                       AND (
                         (
                           connection.authentication_mode = 'none'
                           AND connection.id = ?
                         )
                         OR (
                           connection.authentication_mode <> 'none'
                           AND connection.credential_state = 'present'
                           AND connection.credential_ref IN (
                             'keyring:model-hub:' || ?,
                             'keyring:legacy-model-profile:' || ?
                           )
                         )
                       )
                       AND catalog.revision = ?
                       AND catalog.provider_model_id = ?
                       AND catalog.availability <> 'unavailable'
                   )
                 RETURNING provider_dispatch_started_at, revision",
            )
            .bind(&ledger.invocation_id)
            .bind(&ledger.task_snapshot)
            .bind(&ledger.connection_id)
            .bind(&ledger.catalog_entry_id)
            .bind(&ledger.provider_kind_snapshot)
            .bind(&ledger.model_id_snapshot)
            .bind(ledger.expected_revision)
            .bind(&ledger.catalog_entry_id)
            .bind(&ledger.connection_id)
            .bind(ledger.connection_revision)
            .bind(&ledger.provider_kind_snapshot)
            .bind(&target.protocol)
            .bind(&target.base_url)
            .bind(&target.authentication_mode)
            .bind(&target.credential_header_name)
            .bind(&target.model_discovery_path)
            .bind(&target.text_generation_path)
            .bind(&target.embedding_path)
            .bind(target.request_timeout_ms)
            .bind(&target.credential_provider_id)
            .bind(&target.credential_provider_id)
            .bind(&target.credential_provider_id)
            .bind(ledger.catalog_entry_revision)
            .bind(&target.model_id)
            .fetch_optional(
                bridge
                    .connection_mut()
                    .map_err(|_| ModelInvocationDispatchLedgerError::Unavailable)?,
            )
            .await
            .map_err(|error| match NativeSqliteError::from_sqlx(error).code {
                "SQLITE_BUSY" => ModelInvocationDispatchLedgerError::Busy,
                _ => ModelInvocationDispatchLedgerError::OutcomeUnknown,
            })
        })
        .await;
        let row = match write {
            Ok(Ok(row)) => row,
            Ok(Err(ModelInvocationDispatchLedgerError::Busy)) => {
                return Err(ModelInvocationDispatchLedgerError::Busy)
            }
            Ok(Err(error)) => {
                bridge.invalidate_connection_hard();
                return Err(error);
            }
            Err(_) => {
                bridge.invalidate_connection_hard();
                return Err(ModelInvocationDispatchLedgerError::OutcomeUnknown);
            }
        };
        let Some(row) = row else {
            return Err(ModelInvocationDispatchLedgerError::Conflict);
        };
        Ok(NativeModelInvocationDispatchReceipt {
            invocation_id: ledger.invocation_id.clone(),
            dispatched_at: row
                .try_get("provider_dispatch_started_at")
                .map_err(|_| ModelInvocationDispatchLedgerError::Unavailable)?,
            revision: row
                .try_get("revision")
                .map_err(|_| ModelInvocationDispatchLedgerError::Unavailable)?,
        })
    }

    pub(crate) async fn acquire_project_remote_dispatch_lease(
        &self,
        receipt: &NativeProjectContextPrivacyReceipt,
        endpoint_is_loopback: bool,
        operation_kind: &str,
        operation_id: &str,
    ) -> Result<ProjectRemoteDispatchLease, ProjectRemoteDispatchLeaseError> {
        if !valid_project_dispatch_receipt(receipt)
            || !matches!(operation_kind, "generation" | "embedding" | "rerank")
            || operation_id.is_empty()
            || operation_id.len() > 200
        {
            return Err(ProjectRemoteDispatchLeaseError::AuthorityChanged);
        }

        let mut bridge = self
            .lock_bridge("dispatch_lease_acquire_lock")
            .await
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseBusy)?;
        bridge
            .require_no_transaction()
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseBusy)?;
        let connection = bridge
            .connection_mut()
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
        sqlx::query("PRAGMA query_only = OFF")
            .execute(&mut *connection)
            .await
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseBusy)?;

        let result = acquire_project_remote_dispatch_lease_in_transaction(
            connection,
            receipt,
            endpoint_is_loopback,
            operation_kind,
            operation_id,
            &self.runtime_id,
        )
        .await;
        match result {
            Ok(lease) => {
                if sqlx::query("COMMIT")
                    .execute(&mut *connection)
                    .await
                    .is_err()
                {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                    return Err(ProjectRemoteDispatchLeaseError::DatabaseUnavailable);
                }
                Ok(lease)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    pub(crate) async fn release_project_remote_dispatch_lease(
        &self,
        lease: &ProjectRemoteDispatchLease,
    ) -> Result<(), ProjectRemoteDispatchLeaseError> {
        let mut bridge = self
            .lock_bridge("dispatch_lease_release_lock")
            .await
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseBusy)?;
        bridge
            .require_no_transaction()
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseBusy)?;
        let result = sqlx::query(
            "DELETE FROM project_remote_dispatch_leases WHERE lease_id = ? AND operation_id = ? AND owner_runtime_id = ?",
        )
        .bind(&lease.lease_id)
        .bind(&lease.operation_id)
        .bind(self.runtime_id.as_ref())
        .execute(
            bridge
                .connection_mut()
                .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?,
        )
        .await
        .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
        if result.rows_affected() == 1 {
            Ok(())
        } else {
            Err(ProjectRemoteDispatchLeaseError::DatabaseUnavailable)
        }
    }

    pub(crate) async fn reconcile_project_remote_dispatch_leases(
        &self,
        active_operation_ids: &HashSet<String>,
    ) -> Result<u64, ProjectRemoteDispatchLeaseError> {
        let mut bridge = self
            .lock_bridge("dispatch_lease_reconcile_lock")
            .await
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseBusy)?;
        bridge
            .require_no_transaction()
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseBusy)?;
        let connection = bridge
            .connection_mut()
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
        let rows = sqlx::query(
            "SELECT lease_id, operation_id FROM project_remote_dispatch_leases
             WHERE owner_runtime_id = ?",
        )
        .bind(self.runtime_id.as_ref())
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
        let mut removed = 0u64;
        for row in rows {
            let lease_id = row
                .try_get::<String, _>("lease_id")
                .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
            let operation_id = row
                .try_get::<String, _>("operation_id")
                .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
            if active_operation_ids.contains(&operation_id) {
                continue;
            }
            removed += sqlx::query(
                "DELETE FROM project_remote_dispatch_leases
                 WHERE lease_id = ? AND operation_id = ? AND owner_runtime_id = ?",
            )
            .bind(lease_id)
            .bind(operation_id)
            .bind(self.runtime_id.as_ref())
            .execute(&mut *connection)
            .await
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?
            .rows_affected();
        }
        Ok(removed)
    }

    async fn reconcile_startup_project_remote_dispatch_leases(
        &self,
        connection: &mut SqliteConnection,
    ) -> Result<(), NativeSqliteError> {
        if self.startup_reconciled.load(Ordering::Acquire) {
            return Ok(());
        }
        // The runtime identifier is born with this process. Remove only rows
        // owned by a previous runtime; never use age/deadline as permission to
        // erase a lease that the current native registry may still own.
        sqlx::query("DELETE FROM project_remote_dispatch_leases WHERE owner_runtime_id <> ?")
            .bind(self.runtime_id.as_ref())
            .execute(&mut *connection)
            .await
            .map_err(NativeSqliteError::from_sqlx)?;
        self.startup_reconciled.store(true, Ordering::Release);
        Ok(())
    }
}

async fn acquire_project_remote_dispatch_lease_in_transaction(
    connection: &mut SqliteConnection,
    receipt: &NativeProjectContextPrivacyReceipt,
    endpoint_is_loopback: bool,
    operation_kind: &str,
    operation_id: &str,
    runtime_id: &str,
) -> Result<ProjectRemoteDispatchLease, ProjectRemoteDispatchLeaseError> {
    let active_project_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM projects WHERE id = ? AND status = 'active'",
    )
    .bind(&receipt.project_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
    if active_project_count != 1 {
        return Err(ProjectRemoteDispatchLeaseError::AuthorityChanged);
    }
    let rows = sqlx::query(
        "SELECT id, current_version_id, revision, privacy_revision, privacy_mode, status
         FROM chapters WHERE project_id = ? ORDER BY id",
    )
    .bind(&receipt.project_id)
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
    if rows.len() != receipt.retained_chapter_count || rows.len() != receipt.chapters.len() {
        return Err(ProjectRemoteDispatchLeaseError::AuthorityChanged);
    }
    let mut active_count = 0usize;
    let mut requires_verified_local = false;
    for (row, expected) in rows.iter().zip(&receipt.chapters) {
        let chapter_id = row
            .try_get::<String, _>("id")
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
        let current_version_id = row
            .try_get::<String, _>("current_version_id")
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
        let revision = row
            .try_get::<i64, _>("revision")
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
        let privacy_revision = row
            .try_get::<i64, _>("privacy_revision")
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
        let privacy_mode = row
            .try_get::<String, _>("privacy_mode")
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
        let status = row
            .try_get::<String, _>("status")
            .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
        if chapter_id != expected.chapter_id
            || current_version_id != expected.current_version_id
            || revision != expected.revision
            || privacy_revision != expected.privacy_revision
            || privacy_mode != expected.privacy_mode
            || status != expected.status
        {
            return Err(ProjectRemoteDispatchLeaseError::AuthorityChanged);
        }
        active_count += usize::from(status == "active");
        requires_verified_local |= privacy_mode == "local_only";
    }
    if active_count != receipt.active_chapter_count
        || requires_verified_local != receipt.requires_verified_local
        || canonical_project_context_fingerprint(receipt).as_deref()
            != Some(receipt.fingerprint.as_str())
    {
        return Err(ProjectRemoteDispatchLeaseError::AuthorityChanged);
    }
    if requires_verified_local && !endpoint_is_loopback {
        return Err(ProjectRemoteDispatchLeaseError::PrivateChapterLocalOnly);
    }

    let lease = ProjectRemoteDispatchLease {
        lease_id: uuid::Uuid::now_v7().to_string(),
        operation_id: operation_id.to_owned(),
    };
    sqlx::query(
        "INSERT INTO project_remote_dispatch_leases (
           lease_id, project_id, operation_kind, operation_id, owner_runtime_id,
           authority_fingerprint, acquired_at, network_deadline_at
         ) VALUES (?, ?, ?, ?, ?, ?,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+12 minutes'))",
    )
    .bind(&lease.lease_id)
    .bind(&receipt.project_id)
    .bind(operation_kind)
    .bind(operation_id)
    .bind(runtime_id)
    .bind(&receipt.fingerprint)
    .execute(&mut *connection)
    .await
    .map_err(|_| ProjectRemoteDispatchLeaseError::DatabaseUnavailable)?;
    Ok(lease)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalProjectContext<'a> {
    schema_version: u8,
    project_id: &'a str,
    chapters: &'a [NativeProjectContextChapterAuthority],
}

pub(crate) fn canonical_project_context_fingerprint(
    receipt: &NativeProjectContextPrivacyReceipt,
) -> Option<String> {
    let canonical = serde_json::to_vec(&CanonicalProjectContext {
        schema_version: 1,
        project_id: &receipt.project_id,
        chapters: &receipt.chapters,
    })
    .ok()?;
    let digest = Sha256::digest(canonical);
    Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_project_dispatch_receipt(receipt: &NativeProjectContextPrivacyReceipt) -> bool {
    receipt.schema_version == 1
        && receipt.project_id.len() == 36
        && receipt.fingerprint.len() == 64
        && receipt
            .fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && receipt.retained_chapter_count == receipt.chapters.len()
        && receipt
            .chapters
            .windows(2)
            .all(|pair| pair[0].chapter_id < pair[1].chapter_id)
        && receipt.chapters.iter().all(|chapter| {
            chapter.chapter_id.len() == 36
                && chapter.current_version_id.len() == 36
                && chapter.revision >= 1
                && chapter.privacy_revision >= 1
                && matches!(chapter.privacy_mode.as_str(), "standard" | "local_only")
                && matches!(chapter.status.as_str(), "active" | "trashed")
        })
}

#[derive(Default)]
struct NativeSqliteBridge {
    connection: Option<SqliteConnection>,
    session_token: Option<String>,
    transaction: Option<ActiveTransaction>,
    #[cfg(test)]
    fail_next_begin: bool,
    #[cfg(test)]
    fail_next_query_only_restore: bool,
    #[cfg(test)]
    fail_next_detach: bool,
}

#[derive(Debug)]
struct ActiveTransaction {
    token: String,
    read_only: bool,
    created_at: Instant,
    last_activity: Instant,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum NativeSqlValue {
    Null,
    Text { value: String },
    Integer { value: i64 },
    Real { value: f64 },
    Blob { value: Vec<i64> },
}

#[derive(Clone, Debug)]
enum ValidatedSqlValue {
    Null,
    Text(String),
    Integer(i64),
    Real(f64),
    Blob(Vec<u8>),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSqliteOpenReceipt {
    session_token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeTransactionReceipt {
    transaction_token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeExecuteResult {
    rows_affected: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_insert_id: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSqliteMigrationDiagnostic {
    reason_code: &'static str,
    expected_version: i64,
    actual_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    migration_version: Option<i64>,
    whitelist_reason_code: &'static str,
    native_error_class: &'static str,
    sqlite_primary_code: Option<u32>,
    sqlite_extended_code: Option<u32>,
    cause_chain: Vec<&'static str>,
    component_stack: Vec<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSqliteError {
    code: &'static str,
    message: &'static str,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<&'static str>,
    #[serde(flatten)]
    migration_diagnostic: Option<Box<NativeSqliteMigrationDiagnostic>>,
}

struct SafeMigrationSourceDiagnostic {
    native_error_class: &'static str,
    sqlite_primary_code: Option<u32>,
    sqlite_extended_code: Option<u32>,
    cause_chain: Vec<&'static str>,
}

fn sqlite_numeric_codes(error: &sqlx::Error) -> (Option<u32>, Option<u32>) {
    let extended = match error {
        sqlx::Error::Database(database_error) => database_error
            .code()
            .and_then(|code| code.parse::<u32>().ok()),
        _ => None,
    };
    (extended.map(|code| code & 0xff), extended)
}

fn safe_sqlx_error_variant(error: &sqlx::Error) -> &'static str {
    match error {
        sqlx::Error::Database(_) => "SqlxError::Database",
        sqlx::Error::Configuration(_) => "SqlxError::Configuration",
        sqlx::Error::InvalidArgument(_) => "SqlxError::InvalidArgument",
        sqlx::Error::Io(_) => "SqlxError::Io",
        sqlx::Error::Protocol(_) => "SqlxError::Protocol",
        sqlx::Error::RowNotFound => "SqlxError::RowNotFound",
        sqlx::Error::Encode(_) => "SqlxError::Encode",
        sqlx::Error::Decode(_) | sqlx::Error::ColumnDecode { .. } => "SqlxError::Decode",
        _ => "SqlxError::Other",
    }
}

fn safe_sqlx_error_class(error: &sqlx::Error) -> &'static str {
    let (primary, _) = sqlite_numeric_codes(error);
    match error {
        sqlx::Error::Database(_) => match primary {
            Some(5) => "SQLITE_BUSY",
            Some(8) => "SQLITE_READ_ONLY",
            Some(10) => "SQLITE_IO_ERROR",
            Some(11) => "SQLITE_CORRUPT",
            Some(13) => "SQLITE_FULL",
            Some(19) => "SQLITE_CONSTRAINT",
            Some(26) => "SQLITE_NOT_A_DATABASE",
            _ => "SQLITE_DATABASE_ERROR",
        },
        sqlx::Error::Configuration(_) => "SQLX_CONFIGURATION",
        sqlx::Error::InvalidArgument(_) => "SQLX_INVALID_ARGUMENT",
        sqlx::Error::Io(_) => "SQLX_IO",
        sqlx::Error::Protocol(_) => "SQLX_PROTOCOL",
        sqlx::Error::RowNotFound => "SQLX_ROW_NOT_FOUND",
        sqlx::Error::Encode(_) => "SQLX_ENCODE",
        sqlx::Error::Decode(_) | sqlx::Error::ColumnDecode { .. } => "SQLX_DECODE",
        _ => "SQLX_OTHER",
    }
}

fn safe_migration_source_diagnostic(
    error: &sqlx::migrate::MigrateError,
    reason_code: &'static str,
) -> SafeMigrationSourceDiagnostic {
    use sqlx::migrate::MigrateError;

    let mut cause_chain = vec!["LocalMigrationError"];
    let (native_error_class, sqlite_primary_code, sqlite_extended_code) = match error {
        MigrateError::Execute(error) => {
            cause_chain.push("MigrateError::Execute");
            cause_chain.push(safe_sqlx_error_variant(error));
            let class = safe_sqlx_error_class(error);
            cause_chain.push(class);
            let (primary, extended) = sqlite_numeric_codes(error);
            (class, primary, extended)
        }
        MigrateError::ExecuteMigration(error, _) => {
            cause_chain.push("MigrateError::ExecuteMigration");
            cause_chain.push(safe_sqlx_error_variant(error));
            let class = safe_sqlx_error_class(error);
            cause_chain.push(class);
            let (primary, extended) = sqlite_numeric_codes(error);
            (class, primary, extended)
        }
        MigrateError::Source(_) => {
            cause_chain.push("MigrateError::Source");
            cause_chain.push("MigrationSourceError");
            ("MIGRATE_SOURCE", None, None)
        }
        MigrateError::VersionMissing(_) => {
            cause_chain.push("MigrateError::VersionMissing");
            ("MIGRATE_VERSION_MISSING", None, None)
        }
        MigrateError::VersionMismatch(_) => {
            cause_chain.push("MigrateError::VersionMismatch");
            ("MIGRATE_VERSION_MISMATCH", None, None)
        }
        MigrateError::VersionNotPresent(_) => {
            cause_chain.push("MigrateError::VersionNotPresent");
            ("MIGRATE_VERSION_NOT_PRESENT", None, None)
        }
        MigrateError::VersionTooOld(_, _) => {
            cause_chain.push("MigrateError::VersionTooOld");
            ("MIGRATE_VERSION_TOO_OLD", None, None)
        }
        MigrateError::VersionTooNew(_, _) => {
            cause_chain.push("MigrateError::VersionTooNew");
            ("MIGRATE_VERSION_TOO_NEW", None, None)
        }
        MigrateError::Dirty(_) => {
            cause_chain.push("MigrateError::Dirty");
            ("MIGRATE_DIRTY", None, None)
        }
        _ => {
            cause_chain.push("MigrateError::Other");
            ("MIGRATE_OTHER", None, None)
        }
    };
    if cause_chain.last().copied() != Some(reason_code) {
        cause_chain.push(reason_code);
    }
    cause_chain.truncate(6);
    SafeMigrationSourceDiagnostic {
        native_error_class,
        sqlite_primary_code,
        sqlite_extended_code,
        cause_chain,
    }
}

fn safe_migration_component_stack(
    stage: &'static str,
    reason_code: &'static str,
) -> Vec<&'static str> {
    let mut components = vec![
        "native_sqlite_open",
        "NativeSqliteBridge::open_file",
        "NativeSqliteBridge::open_options_and_migrate",
        "run_local_migrations",
    ];
    if stage == "migration_history_validation" {
        components.push(if reason_code == "PUBLISHED_MIGRATION_BASELINE_INVALID" {
            "verify_published_v029_manifest"
        } else {
            "audit_applied_migration_history"
        });
    } else {
        components.push("Migrator::run_direct");
    }
    components
}

impl NativeSqliteError {
    fn new(code: &'static str, message: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message,
            retryable,
            stage: None,
            outcome: None,
            migration_diagnostic: None,
        }
    }

    fn operation_timeout(stage: &'static str, outcome: &'static str) -> Self {
        Self {
            stage: Some(stage),
            outcome: Some(outcome),
            ..Self::new(
                "SQLITE_OPERATION_TIMEOUT",
                "The local database operation exceeded its bounded execution window.",
                true,
            )
        }
    }

    fn write_outcome_unknown(stage: &'static str) -> Self {
        Self {
            stage: Some(stage),
            outcome: Some("unknown"),
            ..Self::new(
                "SQLITE_WRITE_OUTCOME_UNKNOWN",
                "The local database write result could not be confirmed.",
                false,
            )
        }
    }

    fn commit_outcome_unknown() -> Self {
        Self {
            stage: Some("transaction_commit"),
            outcome: Some("unknown"),
            ..Self::new(
                "SQLITE_COMMIT_OUTCOME_UNKNOWN",
                "The local database commit result could not be confirmed.",
                false,
            )
        }
    }

    fn unavailable() -> Self {
        Self::new(
            "SQLITE_BRIDGE_UNAVAILABLE",
            "The local database connection is unavailable.",
            true,
        )
    }

    fn internal() -> Self {
        Self::new(
            "SQLITE_OPERATION_FAILED",
            "The local database operation failed.",
            true,
        )
    }

    fn busy() -> Self {
        Self::new(
            "SQLITE_BUSY",
            "The local database is busy. Retry after the active operation finishes.",
            true,
        )
    }

    fn disk_full() -> Self {
        Self::new(
            "SQLITE_DISK_FULL",
            "The local database cannot write because the disk is full.",
            false,
        )
    }
    fn database_read_only() -> Self {
        Self::new(
            "SQLITE_READ_ONLY",
            "The local database is read-only. Preserve it and restore write access before retrying.",
            false,
        )
    }

    fn database_corrupt() -> Self {
        Self::new(
            "SQLITE_DATABASE_CORRUPT",
            "The local database is corrupt or is not a valid InkShadow database. Preserve the original file and restore a verified backup.",
            false,
        )
    }

    fn remote_dispatch_active() -> Self {
        Self::new(
            "PROJECT_REMOTE_DISPATCH_ACTIVE",
            "This project is still sending context to the selected AI. Cancel that task or wait for it to finish before enabling local-only privacy or restoring a backup.",
            true,
        )
    }

    fn migration_integrity_failed() -> Self {
        Self::new(
            "SQLITE_MIGRATION_INTEGRITY_FAILED",
            "The local database migration history does not match this InkShadow build. The original database was not replaced.",
            false,
        )
    }

    fn migration_failed() -> Self {
        Self::new(
            "SQLITE_MIGRATION_FAILED",
            "The local database upgrade could not be completed safely. Preserve the original database and restore a verified backup.",
            false,
        )
    }

    fn from_sqlx(error: sqlx::Error) -> Self {
        if matches!(
            &error,
            sqlx::Error::Database(database_error)
                if database_error.message().contains("INKSHADOW_REMOTE_DISPATCH_ACTIVE")
        ) {
            return Self::remote_dispatch_active();
        }
        let extended_code = match &error {
            sqlx::Error::Database(database_error) => database_error
                .code()
                .and_then(|code| code.parse::<u32>().ok()),
            _ => None,
        };
        Self::from_sqlite_extended_code(extended_code)
    }

    fn from_sqlite_extended_code(extended_code: Option<u32>) -> Self {
        match extended_code.map(|code| code & 0xff) {
            // SQLITE_BUSY and every SQLITE_BUSY_* extended result.
            Some(5) => Self::busy(),
            // SQLITE_READONLY and every SQLITE_READONLY_* extended result.
            Some(8) => Self::database_read_only(),
            // SQLITE_FULL has no extended result today, but masking keeps the
            // mapping stable if SQLite introduces one later.
            Some(13) => Self::disk_full(),
            // SQLITE_CORRUPT and SQLITE_NOTADB are terminal integrity failures.
            Some(11 | 26) => Self::database_corrupt(),
            _ => Self::internal(),
        }
    }

    fn from_migrate(error: LocalMigrationError) -> Self {
        use sqlx::migrate::MigrateError;

        let LocalMigrationError {
            source,
            stage,
            reason_code,
            expected_version,
            actual_version,
            migration_version,
            whitelist_reason_code,
        } = error;
        let source_diagnostic = safe_migration_source_diagnostic(&source, reason_code);
        let component_stack = safe_migration_component_stack(stage, reason_code);
        let mut mapped = if stage == "migration_history_validation" {
            Self::migration_integrity_failed()
        } else {
            match *source {
                MigrateError::Execute(error) | MigrateError::ExecuteMigration(error, _) => {
                    let mapped = Self::from_sqlx(error);
                    match mapped.code {
                        "SQLITE_BUSY"
                        | "SQLITE_READ_ONLY"
                        | "SQLITE_DISK_FULL"
                        | "SQLITE_DATABASE_CORRUPT" => mapped,
                        _ => Self::migration_failed(),
                    }
                }
                _ => Self::migration_failed(),
            }
        };
        mapped.stage = Some(stage);
        mapped.migration_diagnostic = Some(Box::new(NativeSqliteMigrationDiagnostic {
            reason_code,
            expected_version,
            actual_version,
            migration_version,
            whitelist_reason_code,
            native_error_class: source_diagnostic.native_error_class,
            sqlite_primary_code: source_diagnostic.sqlite_primary_code,
            sqlite_extended_code: source_diagnostic.sqlite_extended_code,
            cause_chain: source_diagnostic.cause_chain,
            component_stack,
        }));
        mapped
    }

    fn invalidated() -> Self {
        Self::new(
            "SQLITE_CONNECTION_INVALIDATED",
            "The local database connection was invalidated and must be reopened.",
            true,
        )
    }

    fn invalid_request() -> Self {
        Self::new(
            "SQLITE_REQUEST_INVALID",
            "The local database request is invalid or exceeds a safety limit.",
            false,
        )
    }

    fn invalid_path_ticket() -> Self {
        Self::new(
            "SQLITE_PATH_TICKET_INVALID",
            "The selected local database file authorization is invalid or expired.",
            false,
        )
    }

    fn invalid_session() -> Self {
        Self::new(
            "SQLITE_SESSION_INVALID",
            "The local database session is no longer active.",
            false,
        )
    }

    fn transaction_active() -> Self {
        Self::new(
            "SQLITE_TRANSACTION_ACTIVE",
            "A transaction is already active on the local database connection.",
            false,
        )
    }

    fn invalid_transaction() -> Self {
        Self::new(
            "SQLITE_TRANSACTION_INVALID",
            "The local database transaction is no longer active.",
            false,
        )
    }

    fn read_only() -> Self {
        Self::new(
            "SQLITE_TRANSACTION_READ_ONLY",
            "A read-only local database transaction cannot execute mutations.",
            false,
        )
    }
}

fn fail_bounded_bridge_operation<Value>(
    bridge: &mut NativeSqliteBridge,
    error: NativeSqliteError,
) -> Result<Value, NativeSqliteError> {
    bridge.invalidate_connection_hard();
    Err(error)
}

#[tauri::command]
pub(crate) async fn native_sqlite_open(
    app: AppHandle,
    state: State<'_, NativeSqliteState>,
    path_tickets: State<'_, PathTicketState>,
) -> Result<NativeSqliteOpenReceipt, NativeSqliteError> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| NativeSqliteError::unavailable())?;
    std::fs::create_dir_all(&directory).map_err(|_| NativeSqliteError::unavailable())?;
    let path = directory.join(DATABASE_FILE_NAME);

    let mut bridge = state.lock_bridge("open_lock").await?;
    let opened = tokio::time::timeout(state.foreground_operation_timeout, async {
        let receipt = if bridge.connection.is_some() {
            // A WebView reload resets renderer state while native remains
            // alive. Clean orphaned transaction/attachment state and rotate
            // the token. If cleanup cannot be confirmed, discard that handle
            // and reopen the fixed database instead of reusing uncertain state.
            match bridge.adopt_renderer_session().await {
                Ok(receipt) => receipt,
                Err(_) => bridge.open_file(&path).await?,
            }
        } else {
            bridge.open_file(&path).await?
        };
        // A previous process cannot still own a native request: the desktop app is
        // single-instance and this runs before the WebView receives its database
        // session. Remove crash-orphaned leases before any privacy mutation is
        // accepted in the new runtime.
        state
            .reconcile_startup_project_remote_dispatch_leases(bridge.connection_mut()?)
            .await?;
        path_tickets.inner.lock().await.clear();
        Ok(receipt)
    })
    .await;
    match opened {
        Ok(result) => result,
        Err(_) => fail_bounded_bridge_operation(
            &mut bridge,
            NativeSqliteError::operation_timeout("open", "not_confirmed"),
        ),
    }
}

#[tauri::command]
pub(crate) async fn native_sqlite_select(
    state: State<'_, NativeSqliteState>,
    session_token: String,
    query: String,
    values: Vec<NativeSqlValue>,
) -> Result<Vec<JsonMap<String, JsonValue>>, NativeSqliteError> {
    let mut bridge = state.lock_bridge("select_lock").await?;
    let timeout = if is_maintenance_query(&query) {
        state.maintenance_operation_timeout
    } else {
        state.foreground_operation_timeout
    };
    match tokio::time::timeout(timeout, async {
        bridge
            .expire_transaction_if_timed_out(
                state.transaction_idle_timeout,
                state.transaction_max_lifetime,
            )
            .await?;
        let mut rows = bridge.select(&session_token, &query, values).await?;
        redact_database_list_paths(&query, &mut rows);
        Ok(rows)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => fail_bounded_bridge_operation(
            &mut bridge,
            NativeSqliteError::operation_timeout("select", "not_confirmed"),
        ),
    }
}

#[tauri::command]
pub(crate) async fn native_sqlite_execute(
    state: State<'_, NativeSqliteState>,
    path_tickets: State<'_, PathTicketState>,
    session_token: String,
    query: String,
    mut values: Vec<NativeSqlValue>,
) -> Result<NativeExecuteResult, NativeSqliteError> {
    let maintenance = MaintenanceStatement::classify(&query);
    let timeout = if is_maintenance_query(&query) {
        state.maintenance_operation_timeout
    } else {
        state.foreground_operation_timeout
    };
    let mut bridge = state.lock_bridge("execute_lock").await?;
    match tokio::time::timeout(timeout, async {
        bridge
            .expire_transaction_if_timed_out(
                state.transaction_idle_timeout,
                state.transaction_max_lifetime,
            )
            .await?;
        bridge.require_session(&session_token)?;

        if maintenance == MaintenanceStatement::AttachRestoreSource {
            bridge.ensure_no_project_remote_dispatch_leases().await?;
        }
        let ticket_operation = match maintenance {
            MaintenanceStatement::VacuumInto => Some(TicketedPathOperation::VacuumInto),
            MaintenanceStatement::AttachRestoreSource => {
                Some(TicketedPathOperation::AttachRestoreSource)
            }
            _ => None,
        };
        if let Some(operation) = ticket_operation {
            let [NativeSqlValue::Text { value: ticket }] = values.as_slice() else {
                return Err(NativeSqliteError::invalid_path_ticket());
            };
            let ticket = ticket.clone();
            let mut registry = path_tickets.inner.lock().await;
            let authorized_path = registry
                .authorize(&session_token, &ticket, operation)
                .map_err(|_| NativeSqliteError::invalid_path_ticket())?;
            values = vec![NativeSqlValue::Text {
                value: authorized_path.to_string_lossy().into_owned(),
            }];
            let result = bridge.execute(&session_token, &query, values).await;
            match result {
                Ok(receipt) => {
                    if registry
                        .record_success(&session_token, &ticket, operation)
                        .is_err()
                    {
                        registry.record_failure(&ticket);
                        bridge.invalidate_connection().await;
                        return Err(NativeSqliteError::invalidated());
                    }
                    Ok(receipt)
                }
                Err(error) => {
                    registry.record_failure(&ticket);
                    Err(error)
                }
            }
        } else if maintenance == MaintenanceStatement::DetachRestoreSource {
            let mut registry = path_tickets.inner.lock().await;
            registry
                .authorize_detach(&session_token)
                .map_err(|_| NativeSqliteError::invalid_path_ticket())?;
            let result = bridge.execute(&session_token, &query, values).await;
            registry.record_detached();
            result
        } else {
            bridge.execute(&session_token, &query, values).await
        }
    })
    .await
    {
        Ok(result) => result,
        Err(_) => fail_bounded_bridge_operation(
            &mut bridge,
            NativeSqliteError::write_outcome_unknown("execute"),
        ),
    }
}

#[tauri::command]
pub(crate) async fn native_sqlite_begin(
    state: State<'_, NativeSqliteState>,
    session_token: String,
    read_only: bool,
) -> Result<NativeTransactionReceipt, NativeSqliteError> {
    let mut bridge = state.lock_bridge("transaction_begin_lock").await?;
    let transaction_token = match tokio::time::timeout(state.foreground_operation_timeout, async {
        bridge
            .expire_transaction_if_timed_out(
                state.transaction_idle_timeout,
                state.transaction_max_lifetime,
            )
            .await?;
        bridge.begin(&session_token, read_only).await
    })
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            return fail_bounded_bridge_operation(
                &mut bridge,
                NativeSqliteError::operation_timeout("transaction_begin", "not_confirmed"),
            );
        }
    };
    drop(bridge);

    schedule_transaction_expiration(
        Arc::clone(&state.inner),
        session_token,
        transaction_token.clone(),
        state.transaction_idle_timeout,
        state.transaction_max_lifetime,
        state.bridge_lock_timeout,
        state.foreground_operation_timeout,
    );

    Ok(NativeTransactionReceipt { transaction_token })
}

#[tauri::command]
pub(crate) async fn native_sqlite_transaction_select(
    state: State<'_, NativeSqliteState>,
    session_token: String,
    transaction_token: String,
    query: String,
    values: Vec<NativeSqlValue>,
) -> Result<Vec<JsonMap<String, JsonValue>>, NativeSqliteError> {
    let mut bridge = state.lock_bridge("transaction_select_lock").await?;
    match tokio::time::timeout(state.foreground_operation_timeout, async {
        bridge
            .expire_transaction_if_timed_out(
                state.transaction_idle_timeout,
                state.transaction_max_lifetime,
            )
            .await?;
        let mut rows = bridge
            .transaction_select(&session_token, &transaction_token, &query, values)
            .await?;
        redact_database_list_paths(&query, &mut rows);
        Ok(rows)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => fail_bounded_bridge_operation(
            &mut bridge,
            NativeSqliteError::operation_timeout("transaction_select", "not_confirmed"),
        ),
    }
}

#[tauri::command]
pub(crate) async fn native_sqlite_transaction_execute(
    state: State<'_, NativeSqliteState>,
    session_token: String,
    transaction_token: String,
    query: String,
    values: Vec<NativeSqlValue>,
) -> Result<NativeExecuteResult, NativeSqliteError> {
    let mut bridge = state.lock_bridge("transaction_execute_lock").await?;
    match tokio::time::timeout(state.foreground_operation_timeout, async {
        bridge
            .expire_transaction_if_timed_out(
                state.transaction_idle_timeout,
                state.transaction_max_lifetime,
            )
            .await?;
        bridge
            .transaction_execute(&session_token, &transaction_token, &query, values)
            .await
    })
    .await
    {
        Ok(result) => result,
        Err(_) => fail_bounded_bridge_operation(
            &mut bridge,
            NativeSqliteError::operation_timeout("transaction_execute", "not_confirmed"),
        ),
    }
}

#[tauri::command]
pub(crate) async fn native_sqlite_commit(
    state: State<'_, NativeSqliteState>,
    session_token: String,
    transaction_token: String,
) -> Result<(), NativeSqliteError> {
    let mut bridge = state.lock_bridge("transaction_commit_lock").await?;
    match tokio::time::timeout(state.foreground_operation_timeout, async {
        bridge
            .expire_transaction_if_timed_out(
                state.transaction_idle_timeout,
                state.transaction_max_lifetime,
            )
            .await?;
        bridge
            .finish_transaction(&session_token, &transaction_token, true)
            .await
    })
    .await
    {
        Ok(result) => result,
        Err(_) => {
            fail_bounded_bridge_operation(&mut bridge, NativeSqliteError::commit_outcome_unknown())
        }
    }
}

#[tauri::command]
pub(crate) async fn native_sqlite_rollback(
    state: State<'_, NativeSqliteState>,
    session_token: String,
    transaction_token: String,
) -> Result<(), NativeSqliteError> {
    let mut bridge = state.lock_bridge("transaction_rollback_lock").await?;
    match tokio::time::timeout(state.foreground_operation_timeout, async {
        bridge
            .expire_transaction_if_timed_out(
                state.transaction_idle_timeout,
                state.transaction_max_lifetime,
            )
            .await?;
        bridge
            .finish_transaction(&session_token, &transaction_token, false)
            .await
    })
    .await
    {
        Ok(result) => result,
        Err(_) => fail_bounded_bridge_operation(
            &mut bridge,
            NativeSqliteError::write_outcome_unknown("transaction_rollback"),
        ),
    }
}

#[tauri::command]
pub(crate) async fn native_sqlite_close(
    state: State<'_, NativeSqliteState>,
    path_tickets: State<'_, PathTicketState>,
    session_token: String,
) -> Result<(), NativeSqliteError> {
    let mut bridge = state.lock_bridge("close_lock").await?;
    match tokio::time::timeout(state.close_operation_timeout, async {
        bridge.require_session(&session_token)?;
        bridge.ensure_no_project_remote_dispatch_leases().await?;
        let result = bridge.close().await;
        path_tickets
            .inner
            .lock()
            .await
            .revoke_session(&session_token);
        result
    })
    .await
    {
        Ok(result) => result,
        Err(_) => fail_bounded_bridge_operation(
            &mut bridge,
            NativeSqliteError::operation_timeout("close", "not_confirmed"),
        ),
    }
}

#[tauri::command]
pub(crate) async fn native_choose_backup_destination(
    app: AppHandle,
    state: State<'_, NativeSqliteState>,
    path_tickets: State<'_, PathTicketState>,
) -> Result<Option<PathTicketReceipt>, NativeSqliteError> {
    choose_backup_destination(
        app,
        state,
        path_tickets,
        PathTicketPurpose::BackupDestination,
        "保存墨影备份",
        "墨影备份.db",
    )
    .await
}

#[tauri::command]
pub(crate) async fn native_choose_pre_restore_backup_destination(
    app: AppHandle,
    state: State<'_, NativeSqliteState>,
    path_tickets: State<'_, PathTicketState>,
) -> Result<Option<PathTicketReceipt>, NativeSqliteError> {
    let selected = managed_pre_restore_backup_destination(&app)?;
    issue_selected_path(
        state,
        path_tickets,
        PathTicketPurpose::PreRestoreRollbackDestination,
        Some(selected),
    )
    .await
}

fn managed_pre_restore_backup_destination(app: &AppHandle) -> Result<PathBuf, NativeSqliteError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| NativeSqliteError::invalid_path_ticket())?;
    managed_pre_restore_backup_destination_at(&base)
}

fn managed_pre_restore_backup_destination_at(base: &Path) -> Result<PathBuf, NativeSqliteError> {
    fs::create_dir_all(base).map_err(|_| NativeSqliteError::invalid_path_ticket())?;
    let canonical_base = base
        .canonicalize()
        .map_err(|_| NativeSqliteError::invalid_path_ticket())?;
    let root = canonical_base
        .join(PRE_RESTORE_BACKUP_DIRECTORY)
        .join(PRE_RESTORE_BACKUP_VERSION_DIRECTORY);
    fs::create_dir_all(&root).map_err(|_| NativeSqliteError::invalid_path_ticket())?;
    let canonical_root = root
        .canonicalize()
        .map_err(|_| NativeSqliteError::invalid_path_ticket())?;
    if canonical_root == canonical_base || !canonical_root.starts_with(&canonical_base) {
        return Err(NativeSqliteError::invalid_path_ticket());
    }
    Ok(canonical_root.join(format!("inkshadow-pre-restore-{}.db", uuid::Uuid::now_v7())))
}

async fn choose_backup_destination(
    app: AppHandle,
    state: State<'_, NativeSqliteState>,
    path_tickets: State<'_, PathTicketState>,
    purpose: PathTicketPurpose,
    title: &'static str,
    file_name: &'static str,
) -> Result<Option<PathTicketReceipt>, NativeSqliteError> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(title)
            .set_file_name(file_name)
            .add_filter("数据库备份", &["db", "sqlite", "sqlite3"])
            .blocking_save_file()
    })
    .await
    .map_err(|_| NativeSqliteError::invalid_path_ticket())?
    .map(|path| path.into_path())
    .transpose()
    .map_err(|_| NativeSqliteError::invalid_path_ticket())?;
    issue_selected_path(state, path_tickets, purpose, selected).await
}

#[tauri::command]
pub(crate) async fn native_choose_restore_source(
    app: AppHandle,
    state: State<'_, NativeSqliteState>,
    path_tickets: State<'_, PathTicketState>,
) -> Result<Option<PathTicketReceipt>, NativeSqliteError> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择墨影备份")
            .add_filter("数据库备份", &["db", "sqlite", "sqlite3"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| NativeSqliteError::invalid_path_ticket())?
    .map(|path| path.into_path())
    .transpose()
    .map_err(|_| NativeSqliteError::invalid_path_ticket())?;
    issue_selected_path(
        state,
        path_tickets,
        PathTicketPurpose::RestoreSource,
        selected,
    )
    .await
}

async fn issue_selected_path(
    state: State<'_, NativeSqliteState>,
    path_tickets: State<'_, PathTicketState>,
    purpose: PathTicketPurpose,
    selected: Option<PathBuf>,
) -> Result<Option<PathTicketReceipt>, NativeSqliteError> {
    let bridge = state.lock_bridge("path_ticket_lock").await?;
    let session_token = bridge
        .session_token
        .as_deref()
        .ok_or_else(NativeSqliteError::invalid_session)?;
    path_tickets
        .inner
        .lock()
        .await
        .issue_selected_path(session_token, purpose, selected)
        .map_err(|_: PathTicketError| NativeSqliteError::invalid_path_ticket())
}

fn schedule_transaction_expiration(
    state: Arc<Mutex<NativeSqliteBridge>>,
    session_token: String,
    transaction_token: String,
    idle_timeout: Duration,
    max_lifetime: Duration,
    lock_timeout: Duration,
    operation_timeout: Duration,
) {
    tokio::spawn(async move {
        loop {
            let remaining = {
                let Ok(mut bridge) = tokio::time::timeout(lock_timeout, state.lock()).await else {
                    return;
                };

                if bridge.session_token.as_deref() != Some(session_token.as_str()) {
                    return;
                }
                let Some(transaction) = bridge.transaction.as_ref() else {
                    return;
                };
                if transaction.token != transaction_token {
                    return;
                }

                let idle_elapsed = transaction.last_activity.elapsed();
                let lifetime_elapsed = transaction.created_at.elapsed();
                if idle_elapsed >= idle_timeout || lifetime_elapsed >= max_lifetime {
                    if tokio::time::timeout(
                        operation_timeout,
                        bridge.rollback_expired_transaction(),
                    )
                    .await
                    .is_err()
                    {
                        bridge.invalidate_connection_hard();
                    }
                    return;
                }
                idle_timeout
                    .saturating_sub(idle_elapsed)
                    .min(max_lifetime.saturating_sub(lifetime_elapsed))
            };
            tokio::time::sleep(remaining).await;
        }
    });
}

impl NativeSqliteBridge {
    async fn open_file(
        &mut self,
        path: &Path,
    ) -> Result<NativeSqliteOpenReceipt, NativeSqliteError> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(5));
        self.open_options_and_migrate(options, true).await
    }

    async fn open_options_and_migrate(
        &mut self,
        options: SqliteConnectOptions,
        require_wal: bool,
    ) -> Result<NativeSqliteOpenReceipt, NativeSqliteError> {
        let _ = self.close().await;

        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(NativeSqliteError::from_sqlx)?;
        if let Err(error) = configure_connection(&mut connection, require_wal).await {
            let mapped = NativeSqliteError::from_sqlx(error);
            let _ = connection.close().await;
            return Err(mapped);
        }
        if let Err(error) = run_local_migrations(&mut connection).await {
            let mapped = NativeSqliteError::from_migrate(error);
            let _ = connection.close().await;
            return Err(mapped);
        }
        if let Err(error) = verify_connection_configuration(&mut connection).await {
            let _ = connection.close().await;
            return Err(error);
        }

        let session_token = random_token();
        self.connection = Some(connection);
        self.session_token = Some(session_token.clone());
        self.transaction = None;
        Ok(NativeSqliteOpenReceipt { session_token })
    }

    async fn adopt_renderer_session(
        &mut self,
    ) -> Result<NativeSqliteOpenReceipt, NativeSqliteError> {
        if self.connection.is_none() {
            return Err(NativeSqliteError::unavailable());
        }
        if self.transaction.is_some() && self.rollback_active_transaction().await.is_err() {
            self.invalidate_connection().await;
            return Err(NativeSqliteError::invalidated());
        }
        if self.restore_query_only().await.is_err()
            || self.clear_stale_renderer_attachments().await.is_err()
            || verify_connection_configuration(self.connection_mut()?)
                .await
                .is_err()
        {
            self.invalidate_connection_hard();
            return Err(NativeSqliteError::invalidated());
        }

        self.transaction = None;
        let session_token = random_token();
        self.session_token = Some(session_token.clone());
        Ok(NativeSqliteOpenReceipt { session_token })
    }

    #[cfg(test)]
    async fn open_options(
        &mut self,
        options: SqliteConnectOptions,
        require_wal: bool,
    ) -> Result<NativeSqliteOpenReceipt, NativeSqliteError> {
        // close() always clears/takes the previous connection even if its
        // rollback reports an error, so a reload can safely establish a fresh
        // session instead of requiring a second open attempt.
        let _ = self.close().await;

        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(|_| NativeSqliteError::unavailable())?;

        if configure_connection(&mut connection, require_wal)
            .await
            .is_err()
        {
            let _ = connection.close().await;
            return Err(NativeSqliteError::unavailable());
        }

        let session_token = random_token();
        self.connection = Some(connection);
        self.session_token = Some(session_token.clone());
        self.transaction = None;

        Ok(NativeSqliteOpenReceipt { session_token })
    }

    async fn close(&mut self) -> Result<(), NativeSqliteError> {
        let mut first_error = None;
        if self.transaction.is_some() && self.rollback_active_transaction().await.is_err() {
            first_error = Some(NativeSqliteError::internal());
        }

        self.transaction = None;
        self.session_token = None;
        if let Some(mut connection) = self.connection.take() {
            let _ = sqlx::query("PRAGMA query_only = OFF")
                .execute(&mut connection)
                .await;
            if connection.close().await.is_err() && first_error.is_none() {
                first_error = Some(NativeSqliteError::internal());
            }
        }

        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn require_session(&self, token: &str) -> Result<(), NativeSqliteError> {
        if token.len() == 64 && self.session_token.as_deref() == Some(token) {
            Ok(())
        } else {
            Err(NativeSqliteError::invalid_session())
        }
    }

    fn require_no_transaction(&self) -> Result<(), NativeSqliteError> {
        if self.transaction.is_some() {
            Err(NativeSqliteError::transaction_active())
        } else {
            Ok(())
        }
    }

    fn require_transaction(
        &self,
        session_token: &str,
        transaction_token: &str,
    ) -> Result<bool, NativeSqliteError> {
        self.require_session(session_token)?;
        let transaction = self
            .transaction
            .as_ref()
            .filter(|transaction| {
                transaction_token.len() == 64 && transaction.token == transaction_token
            })
            .ok_or_else(NativeSqliteError::invalid_transaction)?;
        Ok(transaction.read_only)
    }

    fn connection_mut(&mut self) -> Result<&mut SqliteConnection, NativeSqliteError> {
        self.connection
            .as_mut()
            .ok_or_else(NativeSqliteError::unavailable)
    }

    async fn select(
        &mut self,
        session_token: &str,
        query: &str,
        values: Vec<NativeSqlValue>,
    ) -> Result<Vec<JsonMap<String, JsonValue>>, NativeSqliteError> {
        self.require_session(session_token)?;
        self.require_no_transaction()?;
        let values = validate_request(query, values, true)?;
        let result = run_read_query(self.connection_mut()?, query, &values, true).await;
        self.finish_toggled_read(result).await
    }

    async fn execute(
        &mut self,
        session_token: &str,
        query: &str,
        values: Vec<NativeSqlValue>,
    ) -> Result<NativeExecuteResult, NativeSqliteError> {
        self.require_session(session_token)?;
        self.require_no_transaction()?;
        let mut values = validate_request(query, values, false)?;
        let maintenance_statement = MaintenanceStatement::classify(query);
        if maintenance_statement == MaintenanceStatement::DeferForeignKeys {
            // Deferral is useful only for the bounded backup-restore
            // transaction. Never let a normal WebView statement preconfigure
            // the next transaction.
            return Err(NativeSqliteError::invalid_request());
        }
        let attachment_path = if maintenance_statement == MaintenanceStatement::AttachRestoreSource
        {
            let [ValidatedSqlValue::Text(path)] = values.as_slice() else {
                return Err(NativeSqliteError::invalid_request());
            };
            Some(PathBuf::from(path))
        } else {
            None
        };
        if maintenance_statement == MaintenanceStatement::VacuumInto {
            self.ensure_vacuum_destination_is_distinct(&values).await?;
        } else if let Some(path) = attachment_path.as_ref() {
            let main = self.database_path("main").await?;
            ensure_distinct_database_paths(&main, path)?;
            values = vec![ValidatedSqlValue::Text(readonly_sqlite_uri(path)?)];
        }

        #[cfg(test)]
        let force_detach_failure = maintenance_statement
            == MaintenanceStatement::DetachRestoreSource
            && std::mem::take(&mut self.fail_next_detach);
        #[cfg(not(test))]
        let force_detach_failure = false;

        let result = if force_detach_failure {
            Err(NativeSqliteError::internal())
        } else {
            run_execute(self.connection_mut()?, query, &values).await
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if maintenance_statement == MaintenanceStatement::DetachRestoreSource {
                    self.invalidate_connection().await;
                    return Err(NativeSqliteError::invalidated());
                }
                return Err(error);
            }
        };

        if maintenance_statement == MaintenanceStatement::AttachRestoreSource {
            if let Err(error) = self
                .ensure_restore_attachment_is_expected(
                    attachment_path
                        .as_deref()
                        .ok_or_else(NativeSqliteError::invalid_request)?,
                )
                .await
            {
                let detached = run_execute(
                    self.connection_mut()?,
                    "DETACH DATABASE restore_source",
                    &[],
                )
                .await
                .is_ok();
                if !detached {
                    self.invalidate_connection().await;
                    return Err(NativeSqliteError::invalidated());
                }
                return Err(error);
            }
        } else if maintenance_statement == MaintenanceStatement::VacuumInto
            && self
                .ensure_vacuum_destination_is_distinct(&values)
                .await
                .is_err()
        {
            self.invalidate_connection().await;
            return Err(NativeSqliteError::invalidated());
        }

        if verify_connection_configuration(self.connection_mut()?)
            .await
            .is_err()
        {
            self.invalidate_connection().await;
            // The autocommit statement already returned success. Losing the
            // connection while checking its postconditions cannot prove
            // whether the caller received the durable write receipt, so the
            // renderer must reopen and reconcile authority instead of retrying.
            return Err(NativeSqliteError::write_outcome_unknown("execute"));
        }
        to_execute_result(result)
    }

    async fn ensure_vacuum_destination_is_distinct(
        &mut self,
        values: &[ValidatedSqlValue],
    ) -> Result<(), NativeSqliteError> {
        let [ValidatedSqlValue::Text(destination)] = values else {
            return Err(NativeSqliteError::invalid_request());
        };
        let main = self.database_path("main").await?;
        ensure_distinct_database_paths(&main, Path::new(destination))
    }

    async fn ensure_restore_attachment_is_expected(
        &mut self,
        expected: &Path,
    ) -> Result<(), NativeSqliteError> {
        let main = self.database_path("main").await?;
        let source = self.database_path("restore_source").await?;
        ensure_distinct_database_paths(&main, &source)?;
        match same_file::is_same_file(&source, expected) {
            Ok(true) => Ok(()),
            Ok(false) | Err(_) => Err(NativeSqliteError::invalid_request()),
        }
    }

    async fn ensure_no_project_remote_dispatch_leases(&mut self) -> Result<(), NativeSqliteError> {
        let active =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM project_remote_dispatch_leases")
                .fetch_one(self.connection_mut()?)
                .await
                .map_err(NativeSqliteError::from_sqlx)?;
        if active > 0 {
            Err(NativeSqliteError::remote_dispatch_active())
        } else {
            Ok(())
        }
    }

    async fn database_path(&mut self, name: &str) -> Result<PathBuf, NativeSqliteError> {
        let rows = sqlx::query("PRAGMA database_list")
            .fetch_all(self.connection_mut()?)
            .await
            .map_err(|_| NativeSqliteError::internal())?;
        rows.into_iter()
            .find_map(|row| {
                let database_name = row.try_get::<String, _>("name").ok()?;
                if database_name != name {
                    return None;
                }
                row.try_get::<String, _>("file").ok().map(PathBuf::from)
            })
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or_else(NativeSqliteError::internal)
    }

    async fn clear_stale_renderer_attachments(&mut self) -> Result<(), NativeSqliteError> {
        let names = self.database_names().await?;
        if names
            .iter()
            .any(|name| !matches!(name.as_str(), "main" | "temp" | "restore_source"))
        {
            return Err(NativeSqliteError::invalidated());
        }
        if names.iter().any(|name| name == "restore_source") {
            #[cfg(test)]
            let force_detach_failure = std::mem::take(&mut self.fail_next_detach);
            #[cfg(not(test))]
            let force_detach_failure = false;
            if force_detach_failure
                || sqlx::query("DETACH DATABASE restore_source")
                    .execute(self.connection_mut()?)
                    .await
                    .is_err()
            {
                return Err(NativeSqliteError::invalidated());
            }
        }

        let remaining = self.database_names().await?;
        if remaining
            .iter()
            .all(|name| matches!(name.as_str(), "main" | "temp"))
        {
            Ok(())
        } else {
            Err(NativeSqliteError::invalidated())
        }
    }

    async fn database_names(&mut self) -> Result<Vec<String>, NativeSqliteError> {
        sqlx::query("PRAGMA database_list")
            .fetch_all(self.connection_mut()?)
            .await
            .map_err(NativeSqliteError::from_sqlx)?
            .into_iter()
            .map(|row| {
                row.try_get::<String, _>("name")
                    .map_err(|_| NativeSqliteError::internal())
            })
            .collect()
    }

    async fn begin(
        &mut self,
        session_token: &str,
        read_only: bool,
    ) -> Result<String, NativeSqliteError> {
        self.require_session(session_token)?;
        self.require_no_transaction()?;

        let pragma = if read_only {
            "PRAGMA query_only = ON"
        } else {
            "PRAGMA query_only = OFF"
        };
        if sqlx::query(pragma)
            .execute(self.connection_mut()?)
            .await
            .is_err()
        {
            self.invalidate_connection().await;
            return Err(NativeSqliteError::invalidated());
        }
        let query_only = match sqlx::query_scalar::<_, i64>("PRAGMA query_only")
            .fetch_one(self.connection_mut()?)
            .await
        {
            Ok(value) => value,
            Err(_) => {
                self.invalidate_connection().await;
                return Err(NativeSqliteError::invalidated());
            }
        };
        if query_only != i64::from(read_only) {
            if self.restore_query_only().await.is_err() {
                self.invalidate_connection().await;
                return Err(NativeSqliteError::invalidated());
            }
            return Err(NativeSqliteError::internal());
        }

        let begin_sql = if read_only {
            "BEGIN DEFERRED"
        } else {
            "BEGIN IMMEDIATE"
        };
        #[cfg(test)]
        let force_begin_failure = std::mem::take(&mut self.fail_next_begin);
        #[cfg(not(test))]
        let force_begin_failure = false;
        let begin_error = if force_begin_failure {
            Some(NativeSqliteError::internal())
        } else {
            sqlx::query(begin_sql)
                .execute(self.connection_mut()?)
                .await
                .err()
                .map(NativeSqliteError::from_sqlx)
        };
        if let Some(begin_error) = begin_error {
            if self.restore_query_only().await.is_err() {
                self.invalidate_connection().await;
                return Err(NativeSqliteError::invalidated());
            }
            return Err(begin_error);
        }

        let token = random_token();
        let now = Instant::now();
        self.transaction = Some(ActiveTransaction {
            token: token.clone(),
            read_only,
            created_at: now,
            last_activity: now,
        });
        Ok(token)
    }

    async fn transaction_select(
        &mut self,
        session_token: &str,
        transaction_token: &str,
        query: &str,
        values: Vec<NativeSqlValue>,
    ) -> Result<Vec<JsonMap<String, JsonValue>>, NativeSqliteError> {
        let read_only = self.require_transaction(session_token, transaction_token)?;
        let values = validate_request(query, values, true)?;
        let result = run_read_query(self.connection_mut()?, query, &values, !read_only).await;
        let result = if read_only {
            result
        } else {
            self.finish_toggled_read(result).await
        };
        if result.is_ok() {
            self.touch_transaction(transaction_token);
        }
        result
    }

    async fn transaction_execute(
        &mut self,
        session_token: &str,
        transaction_token: &str,
        query: &str,
        values: Vec<NativeSqlValue>,
    ) -> Result<NativeExecuteResult, NativeSqliteError> {
        if self.require_transaction(session_token, transaction_token)? {
            return Err(NativeSqliteError::read_only());
        }
        if !matches!(
            MaintenanceStatement::classify(query),
            MaintenanceStatement::Other | MaintenanceStatement::DeferForeignKeys
        ) {
            return Err(NativeSqliteError::invalid_request());
        }

        let values = validate_request(query, values, false)?;
        let result = run_execute(self.connection_mut()?, query, &values).await;
        let result = result?;
        if verify_connection_configuration(self.connection_mut()?)
            .await
            .is_err()
        {
            self.invalidate_connection().await;
            return Err(NativeSqliteError::invalidated());
        }
        let result = to_execute_result(result)?;
        self.touch_transaction(transaction_token);
        Ok(result)
    }

    async fn finish_transaction(
        &mut self,
        session_token: &str,
        transaction_token: &str,
        commit: bool,
    ) -> Result<(), NativeSqliteError> {
        let read_only = self.require_transaction(session_token, transaction_token)?;
        let result = {
            let connection = self.connection_mut()?;
            let sql = if commit { "COMMIT" } else { "ROLLBACK" };
            sqlx::query(sql).execute(&mut *connection).await
        };

        if let Err(error) = result {
            let operation_error = NativeSqliteError::from_sqlx(error);
            let mut recovered = if commit {
                sqlx::query("ROLLBACK")
                    .execute(self.connection_mut()?)
                    .await
                    .is_ok()
            } else {
                false
            };
            if read_only && self.restore_query_only().await.is_err() {
                recovered = false;
            }
            self.transaction = None;
            if recovered
                && verify_connection_configuration(self.connection_mut()?)
                    .await
                    .is_err()
            {
                recovered = false;
            }
            if !recovered {
                self.invalidate_connection().await;
                return Err(if commit {
                    NativeSqliteError::commit_outcome_unknown()
                } else {
                    NativeSqliteError::invalidated()
                });
            }
            return Err(operation_error);
        }

        if read_only && self.restore_query_only().await.is_err() {
            self.transaction = None;
            self.invalidate_connection().await;
            return Err(if commit {
                NativeSqliteError::commit_outcome_unknown()
            } else {
                NativeSqliteError::invalidated()
            });
        }
        self.transaction = None;

        if verify_connection_configuration(self.connection_mut()?)
            .await
            .is_err()
        {
            self.invalidate_connection().await;
            return Err(if commit {
                NativeSqliteError::commit_outcome_unknown()
            } else {
                NativeSqliteError::invalidated()
            });
        }
        Ok(())
    }

    async fn expire_transaction_if_timed_out(
        &mut self,
        idle_timeout: Duration,
        max_lifetime: Duration,
    ) -> Result<(), NativeSqliteError> {
        let expired = self.transaction.as_ref().is_some_and(|transaction| {
            transaction.last_activity.elapsed() >= idle_timeout
                || transaction.created_at.elapsed() >= max_lifetime
        });
        if expired {
            self.rollback_expired_transaction().await?;
        }
        Ok(())
    }

    async fn rollback_expired_transaction(&mut self) -> Result<(), NativeSqliteError> {
        match self.rollback_active_transaction().await {
            Ok(()) => {
                self.transaction = None;
                Ok(())
            }
            Err(_) => {
                self.invalidate_connection().await;
                Err(NativeSqliteError::invalidated())
            }
        }
    }

    async fn rollback_active_transaction(&mut self) -> Result<(), NativeSqliteError> {
        let read_only = self
            .transaction
            .as_ref()
            .is_some_and(|transaction| transaction.read_only);
        let Some(connection) = self.connection.as_mut() else {
            self.transaction = None;
            return Ok(());
        };

        let rollback = sqlx::query("ROLLBACK").execute(&mut *connection).await;
        self.transaction = None;
        if rollback.is_err() {
            return Err(NativeSqliteError::internal());
        }
        if read_only {
            self.restore_query_only().await?;
        }
        Ok(())
    }

    async fn invalidate_connection(&mut self) {
        self.transaction = None;
        self.session_token = None;
        if let Some(connection) = self.connection.take() {
            let _ = connection.close().await;
        }
    }

    fn invalidate_connection_hard(&mut self) {
        self.transaction = None;
        self.session_token = None;
        if let Some(connection) = self.connection.take() {
            // `SqliteConnection::close_hard` is implemented by dropping the
            // handle. Do that synchronously so timeout recovery cannot itself
            // become another unbounded await.
            drop(connection);
        }
    }

    fn touch_transaction(&mut self, transaction_token: &str) {
        if let Some(transaction) = self
            .transaction
            .as_mut()
            .filter(|transaction| transaction.token == transaction_token)
        {
            transaction.last_activity = Instant::now();
        }
    }

    async fn finish_toggled_read(
        &mut self,
        result: Result<Vec<JsonMap<String, JsonValue>>, NativeSqliteError>,
    ) -> Result<Vec<JsonMap<String, JsonValue>>, NativeSqliteError> {
        if self.restore_query_only().await.is_err()
            || verify_connection_configuration(self.connection_mut()?)
                .await
                .is_err()
        {
            self.invalidate_connection().await;
            return Err(NativeSqliteError::invalidated());
        }
        result
    }

    async fn restore_query_only(&mut self) -> Result<(), NativeSqliteError> {
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_query_only_restore) {
            return Err(NativeSqliteError::internal());
        }
        sqlx::query("PRAGMA query_only = OFF")
            .execute(self.connection_mut()?)
            .await
            .map(|_| ())
            .map_err(|_| NativeSqliteError::internal())
    }
}

async fn configure_connection(
    connection: &mut SqliteConnection,
    require_wal: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await?;
    sqlx::query("PRAGMA journal_mode = WAL")
        .execute(&mut *connection)
        .await?;
    sqlx::query("PRAGMA synchronous = NORMAL")
        .execute(&mut *connection)
        .await?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut *connection)
        .await?;
    sqlx::query("PRAGMA query_only = OFF")
        .execute(&mut *connection)
        .await?;
    verify_connection_configuration_raw(connection, require_wal).await
}

async fn verify_connection_configuration(
    connection: &mut SqliteConnection,
) -> Result<(), NativeSqliteError> {
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| NativeSqliteError::internal())?;
    let query_only: i64 = sqlx::query_scalar("PRAGMA query_only")
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| NativeSqliteError::internal())?;
    if foreign_keys == 1 && query_only == 0 {
        Ok(())
    } else {
        Err(NativeSqliteError::internal())
    }
}

async fn verify_connection_configuration_raw(
    connection: &mut SqliteConnection,
    require_wal: bool,
) -> Result<(), sqlx::Error> {
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&mut *connection)
        .await?;
    let query_only: i64 = sqlx::query_scalar("PRAGMA query_only")
        .fetch_one(&mut *connection)
        .await?;
    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut *connection)
        .await?;
    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(&mut *connection)
        .await?;
    let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(&mut *connection)
        .await?;
    if foreign_keys == 1
        && query_only == 0
        && (!require_wal || journal_mode.eq_ignore_ascii_case("wal"))
        && synchronous == 1
        && busy_timeout >= 5_000
    {
        Ok(())
    } else {
        Err(sqlx::Error::Protocol(
            "SQLite connection configuration could not be verified.".to_owned(),
        ))
    }
}

fn validate_request(
    query: &str,
    values: Vec<NativeSqlValue>,
    read: bool,
) -> Result<Vec<ValidatedSqlValue>, NativeSqliteError> {
    validate_sql(query, read)?;
    if values.len() > MAX_BIND_VALUES {
        return Err(NativeSqliteError::invalid_request());
    }

    let mut bind_bytes = 0_usize;
    let mut validated = Vec::with_capacity(values.len());
    for value in values {
        let value = match value {
            NativeSqlValue::Null => ValidatedSqlValue::Null,
            NativeSqlValue::Text { value } => {
                validate_cell_size(value.len(), &mut bind_bytes, MAX_BIND_BYTES)?;
                ValidatedSqlValue::Text(value)
            }
            NativeSqlValue::Integer { value } => {
                if !(-MAX_SAFE_JS_INTEGER..=MAX_SAFE_JS_INTEGER).contains(&value) {
                    return Err(NativeSqliteError::invalid_request());
                }
                ValidatedSqlValue::Integer(value)
            }
            NativeSqlValue::Real { value } => {
                if !value.is_finite() {
                    return Err(NativeSqliteError::invalid_request());
                }
                ValidatedSqlValue::Real(value)
            }
            NativeSqlValue::Blob { value } => {
                validate_cell_size(value.len(), &mut bind_bytes, MAX_BIND_BYTES)?;
                let bytes = value
                    .into_iter()
                    .map(|byte| {
                        u8::try_from(byte).map_err(|_| NativeSqliteError::invalid_request())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                ValidatedSqlValue::Blob(bytes)
            }
        };
        validated.push(value);
    }
    if !read {
        validate_maintenance_statement_bindings(query, &validated)?;
    }
    Ok(validated)
}

fn validate_cell_size(
    size: usize,
    accumulated: &mut usize,
    total_limit: usize,
) -> Result<(), NativeSqliteError> {
    if size > MAX_CELL_BYTES {
        return Err(NativeSqliteError::invalid_request());
    }
    *accumulated = accumulated
        .checked_add(size)
        .ok_or_else(NativeSqliteError::invalid_request)?;
    if *accumulated > total_limit {
        return Err(NativeSqliteError::invalid_request());
    }
    Ok(())
}

fn validate_sql(query: &str, read: bool) -> Result<(), NativeSqliteError> {
    if query.is_empty() || query.len() > MAX_SQL_BYTES || query.contains('\0') {
        return Err(NativeSqliteError::invalid_request());
    }
    ensure_single_statement(query)?;
    if contains_protected_sql_identifier_prefix(query, "project_remote_dispatch_") {
        // This table is a native network-lifetime capability, not application
        // data. The renderer may neither observe nor mutate it through the SQL
        // bridge; native gateway methods use the pinned connection directly.
        return Err(NativeSqliteError::invalid_request());
    }

    let normalized = strip_leading_space_and_comments(query);
    let lower = normalized.to_ascii_lowercase();
    if lower.contains("database_list") && !is_exact_database_list_pragma(normalized) {
        // `pragma_database_list` is a virtual table and can otherwise be
        // aliased or transformed to disclose native-authorized paths.
        return Err(NativeSqliteError::invalid_request());
    }
    let keyword = normalized
        .split(|character: char| !character.is_ascii_alphabetic())
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();

    if read {
        match keyword.as_str() {
            "select" | "with" | "values" | "explain" => Ok(()),
            "pragma" if is_allowed_read_pragma(normalized) => Ok(()),
            _ => Err(NativeSqliteError::invalid_request()),
        }
    } else {
        match keyword.as_str() {
            "attach"
                if canonical_statement(normalized) == "attach database ? as restore_source" =>
            {
                Ok(())
            }
            "detach" if canonical_statement(normalized) == "detach database restore_source" => {
                Ok(())
            }
            "vacuum" if canonical_statement(normalized) == "vacuum into ?" => Ok(()),
            "pragma" if canonical_statement(normalized) == "pragma defer_foreign_keys = on" => {
                Ok(())
            }
            "attach" | "begin" | "commit" | "detach" | "end" | "pragma" | "release"
            | "rollback" | "savepoint" | "vacuum" => Err(NativeSqliteError::invalid_request()),
            _ => Ok(()),
        }
    }
}

fn contains_protected_sql_identifier_prefix(sql: &str, protected_prefix: &str) -> bool {
    #[derive(Clone, Copy, Eq, PartialEq)]
    enum Mode {
        Plain,
        LineComment,
        BlockComment,
    }

    let bytes = sql.as_bytes();
    let mut index = 0usize;
    let mut mode = Mode::Plain;
    while index < bytes.len() {
        match mode {
            Mode::LineComment => {
                if bytes[index] == b'\n' {
                    mode = Mode::Plain;
                }
                index += 1;
            }
            Mode::BlockComment => {
                if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
                    mode = Mode::Plain;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            Mode::Plain => {
                if bytes[index] == b'-' && bytes.get(index + 1) == Some(&b'-') {
                    mode = Mode::LineComment;
                    index += 2;
                    continue;
                }
                if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
                    mode = Mode::BlockComment;
                    index += 2;
                    continue;
                }
                let (end, token) = match bytes[index] {
                    b'"' | b'`' | b'\'' => {
                        let quote = bytes[index];
                        let mut cursor = index + 1;
                        let mut token = Vec::new();
                        while cursor < bytes.len() {
                            if bytes[cursor] == quote {
                                if bytes.get(cursor + 1) == Some(&quote) {
                                    token.push(quote);
                                    cursor += 2;
                                    continue;
                                }
                                cursor += 1;
                                break;
                            }
                            token.push(bytes[cursor]);
                            cursor += 1;
                        }
                        (cursor, token)
                    }
                    b'[' => {
                        let mut cursor = index + 1;
                        let mut token = Vec::new();
                        while cursor < bytes.len() && bytes[cursor] != b']' {
                            token.push(bytes[cursor]);
                            cursor += 1;
                        }
                        (cursor.saturating_add(1).min(bytes.len()), token)
                    }
                    byte if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' => {
                        let mut cursor = index + 1;
                        while cursor < bytes.len()
                            && (bytes[cursor].is_ascii_alphanumeric()
                                || matches!(bytes[cursor], b'_' | b'$'))
                        {
                            cursor += 1;
                        }
                        (cursor, bytes[index..cursor].to_vec())
                    }
                    _ => {
                        index += 1;
                        continue;
                    }
                };
                if token.len() >= protected_prefix.len()
                    && token[..protected_prefix.len()]
                        .eq_ignore_ascii_case(protected_prefix.as_bytes())
                {
                    return true;
                }
                index = end;
            }
        }
    }
    false
}

fn is_exact_database_list_pragma(query: &str) -> bool {
    canonical_statement(strip_leading_space_and_comments(query)) == "pragma database_list"
}

fn redact_database_list_paths(query: &str, rows: &mut [JsonMap<String, JsonValue>]) {
    if !is_exact_database_list_pragma(query) {
        return;
    }
    for row in rows {
        let Some(JsonValue::String(name)) = row.get("name") else {
            continue;
        };
        let redacted = match name.as_str() {
            "main" => "native://main",
            "restore_source" => "native://restore-source",
            "temp" => "native://temp",
            _ => "native://redacted",
        };
        row.insert("file".to_owned(), JsonValue::String(redacted.to_owned()));
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MaintenanceStatement {
    AttachRestoreSource,
    DeferForeignKeys,
    DetachRestoreSource,
    VacuumInto,
    Other,
}

impl MaintenanceStatement {
    fn classify(query: &str) -> Self {
        match canonical_statement(strip_leading_space_and_comments(query)).as_str() {
            "attach database ? as restore_source" => Self::AttachRestoreSource,
            "pragma defer_foreign_keys = on" => Self::DeferForeignKeys,
            "detach database restore_source" => Self::DetachRestoreSource,
            "vacuum into ?" => Self::VacuumInto,
            _ => Self::Other,
        }
    }
}

fn ensure_distinct_database_paths(main: &Path, candidate: &Path) -> Result<(), NativeSqliteError> {
    match same_file::is_same_file(main, candidate) {
        Ok(false) => Ok(()),
        Ok(true) => Err(NativeSqliteError::invalid_request()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let canonical_main =
                std::fs::canonicalize(main).map_err(|_| NativeSqliteError::invalid_request())?;
            let candidate_parent = candidate
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            let candidate_name = candidate
                .file_name()
                .ok_or_else(NativeSqliteError::invalid_request)?;
            let canonical_parent = std::fs::canonicalize(candidate_parent)
                .map_err(|_| NativeSqliteError::invalid_request())?;
            if canonical_main == canonical_parent.join(candidate_name) {
                Err(NativeSqliteError::invalid_request())
            } else {
                Ok(())
            }
        }
        Err(_) => Err(NativeSqliteError::invalid_request()),
    }
}

fn canonical_statement(sql: &str) -> String {
    sql.trim()
        .trim_end_matches(';')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn is_maintenance_query(query: &str) -> bool {
    let normalized = canonical_statement(strip_leading_space_and_comments(query));
    normalized.starts_with("vacuum")
        || normalized.starts_with("attach database")
        || normalized.starts_with("detach database")
        || normalized.starts_with("pragma integrity_check")
        || normalized.starts_with("pragma foreign_key_check")
}

fn validate_maintenance_statement_bindings(
    query: &str,
    values: &[ValidatedSqlValue],
) -> Result<(), NativeSqliteError> {
    match canonical_statement(strip_leading_space_and_comments(query)).as_str() {
        "attach database ? as restore_source" => match values {
            [ValidatedSqlValue::Text(path)] if is_bounded_database_path(path) => Ok(()),
            _ => Err(NativeSqliteError::invalid_request()),
        },
        "detach database restore_source" => {
            if values.is_empty() {
                Ok(())
            } else {
                Err(NativeSqliteError::invalid_request())
            }
        }
        "pragma defer_foreign_keys = on" => {
            if values.is_empty() {
                Ok(())
            } else {
                Err(NativeSqliteError::invalid_request())
            }
        }
        "vacuum into ?" => match values {
            [ValidatedSqlValue::Text(path)]
                if !path.trim().is_empty()
                    && path.len() <= MAX_DATABASE_FILE_PATH_BYTES
                    && !path.contains('\0')
                    && !path.to_ascii_lowercase().starts_with("file:") =>
            {
                Ok(())
            }
            _ => Err(NativeSqliteError::invalid_request()),
        },
        _ => Ok(()),
    }
}

fn is_bounded_database_path(path: &str) -> bool {
    !path.trim().is_empty()
        && path.len() <= MAX_DATABASE_FILE_PATH_BYTES
        && !path.contains('\0')
        && !path.to_ascii_lowercase().starts_with("file:")
        && Path::new(path).is_absolute()
}

fn readonly_sqlite_uri(path: &Path) -> Result<String, NativeSqliteError> {
    let path = path
        .to_str()
        .filter(|path| is_bounded_database_path(path))
        .ok_or_else(NativeSqliteError::invalid_request)?;
    #[cfg(windows)]
    let normalized = path.replace('\\', "/");
    #[cfg(not(windows))]
    let normalized = path.to_owned();

    let mut uri = String::with_capacity(normalized.len().saturating_mul(3) + 13);
    uri.push_str("file:");
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in normalized.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            uri.push(char::from(byte));
        } else {
            uri.push('%');
            uri.push(char::from(HEX[usize::from(byte >> 4)]));
            uri.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    uri.push_str("?mode=ro");
    Ok(uri)
}

fn strip_leading_space_and_comments(mut sql: &str) -> &str {
    loop {
        sql = sql.trim_start();
        if let Some(comment) = sql.strip_prefix("--") {
            if let Some(index) = comment.find('\n') {
                sql = &comment[index + 1..];
                continue;
            }
            return "";
        }
        if let Some(comment) = sql.strip_prefix("/*") {
            if let Some(index) = comment.find("*/") {
                sql = &comment[index + 2..];
                continue;
            }
            return "";
        }
        return sql;
    }
}

fn is_allowed_read_pragma(sql: &str) -> bool {
    let Some(rest) = sql
        .get("pragma".len()..)
        .map(str::trim_start)
        .filter(|rest| !rest.is_empty())
    else {
        return false;
    };
    if rest.contains('=') {
        return false;
    }

    let name_end = rest
        .find(|character: char| {
            character.is_ascii_whitespace() || character == '(' || character == ';'
        })
        .unwrap_or(rest.len());
    let name = rest[..name_end]
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let suffix = rest[name_end..].trim();
    let allowed: HashSet<&'static str> = HashSet::from([
        "database_list",
        "foreign_key_check",
        "foreign_key_list",
        "foreign_keys",
        "index_info",
        "index_list",
        "index_xinfo",
        "integrity_check",
        "quick_check",
        "table_info",
        "table_list",
        "table_xinfo",
    ]);
    if !allowed.contains(name.as_str()) {
        return false;
    }

    match name.as_str() {
        "database_list" | "foreign_keys" | "table_list" => suffix.is_empty() || suffix == ";",
        _ => true,
    }
}

fn ensure_single_statement(sql: &str) -> Result<(), NativeSqliteError> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mode {
        Plain,
        SingleQuote,
        DoubleQuote,
        Backtick,
        Bracket,
        LineComment,
        BlockComment,
    }

    let bytes = sql.as_bytes();
    let mut mode = Mode::Plain;
    let mut index = 0_usize;
    let mut terminal_semicolon = None;
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        match mode {
            Mode::Plain => match (byte, next) {
                (b'\'', _) => mode = Mode::SingleQuote,
                (b'"', _) => mode = Mode::DoubleQuote,
                (b'`', _) => mode = Mode::Backtick,
                (b'[', _) => mode = Mode::Bracket,
                (b'-', Some(b'-')) => {
                    mode = Mode::LineComment;
                    index += 1;
                }
                (b'/', Some(b'*')) => {
                    mode = Mode::BlockComment;
                    index += 1;
                }
                (b';', _) => terminal_semicolon = Some(index),
                _ => {
                    if terminal_semicolon.is_some() && !byte.is_ascii_whitespace() {
                        return Err(NativeSqliteError::invalid_request());
                    }
                }
            },
            Mode::SingleQuote => {
                if byte == b'\'' {
                    if next == Some(b'\'') {
                        index += 1;
                    } else {
                        mode = Mode::Plain;
                    }
                }
            }
            Mode::DoubleQuote => {
                if byte == b'"' {
                    if next == Some(b'"') {
                        index += 1;
                    } else {
                        mode = Mode::Plain;
                    }
                }
            }
            Mode::Backtick => {
                if byte == b'`' {
                    if next == Some(b'`') {
                        index += 1;
                    } else {
                        mode = Mode::Plain;
                    }
                }
            }
            Mode::Bracket => {
                if byte == b']' {
                    mode = Mode::Plain;
                }
            }
            Mode::LineComment => {
                if byte == b'\n' {
                    mode = Mode::Plain;
                }
            }
            Mode::BlockComment => {
                if (byte, next) == (b'*', Some(b'/')) {
                    mode = Mode::Plain;
                    index += 1;
                }
            }
        }
        index += 1;
    }

    match mode {
        Mode::Plain | Mode::LineComment => Ok(()),
        _ => Err(NativeSqliteError::invalid_request()),
    }
}

async fn run_read_query(
    connection: &mut SqliteConnection,
    query: &str,
    values: &[ValidatedSqlValue],
    toggle_query_only: bool,
) -> Result<Vec<JsonMap<String, JsonValue>>, NativeSqliteError> {
    if toggle_query_only {
        sqlx::query("PRAGMA query_only = ON")
            .execute(&mut *connection)
            .await
            .map_err(NativeSqliteError::from_sqlx)?;
    }

    fetch_rows(connection, query, values).await
}

async fn fetch_rows(
    connection: &mut SqliteConnection,
    query: &str,
    values: &[ValidatedSqlValue],
) -> Result<Vec<JsonMap<String, JsonValue>>, NativeSqliteError> {
    let mut statement = sqlx::query(query);
    for value in values {
        statement = match value {
            ValidatedSqlValue::Null => statement.bind(None::<String>),
            ValidatedSqlValue::Text(value) => statement.bind(value),
            ValidatedSqlValue::Integer(value) => statement.bind(value),
            ValidatedSqlValue::Real(value) => statement.bind(value),
            ValidatedSqlValue::Blob(value) => statement.bind(value),
        };
    }

    let mut stream = statement.fetch(&mut *connection);
    let mut rows = Vec::new();
    let mut result_bytes = 0_usize;
    while let Some(row) = stream
        .try_next()
        .await
        .map_err(NativeSqliteError::from_sqlx)?
    {
        if rows.len() >= MAX_RESULT_ROWS {
            return Err(NativeSqliteError::invalid_request());
        }
        rows.push(decode_row(&row, &mut result_bytes)?);
    }
    Ok(rows)
}

fn decode_row(
    row: &SqliteRow,
    result_bytes: &mut usize,
) -> Result<JsonMap<String, JsonValue>, NativeSqliteError> {
    if row.columns().len() > MAX_RESULT_COLUMNS {
        return Err(NativeSqliteError::invalid_request());
    }

    let mut decoded = JsonMap::new();
    for (index, column) in row.columns().iter().enumerate() {
        let name = column.name();
        if name.len() > MAX_COLUMN_NAME_BYTES {
            return Err(NativeSqliteError::invalid_request());
        }
        accumulate_result_bytes(result_bytes, name.len())?;

        let raw = row
            .try_get_raw(index)
            .map_err(|_| NativeSqliteError::internal())?;
        let value = if raw.is_null() {
            JsonValue::Null
        } else {
            match raw.type_info().name() {
                "INTEGER" | "NUMERIC" | "BOOLEAN" => {
                    let value = row
                        .try_get::<i64, _>(index)
                        .map_err(|_| NativeSqliteError::internal())?;
                    if !(-MAX_SAFE_JS_INTEGER..=MAX_SAFE_JS_INTEGER).contains(&value) {
                        return Err(NativeSqliteError::invalid_request());
                    }
                    JsonValue::from(value)
                }
                "REAL" => {
                    let value = row
                        .try_get::<f64, _>(index)
                        .map_err(|_| NativeSqliteError::internal())?;
                    if !value.is_finite() {
                        return Err(NativeSqliteError::invalid_request());
                    }
                    JsonValue::from(value)
                }
                "TEXT" | "DATE" | "TIME" | "DATETIME" => {
                    let value = row
                        .try_get::<String, _>(index)
                        .map_err(|_| NativeSqliteError::internal())?;
                    accumulate_cell_bytes(result_bytes, value.len())?;
                    JsonValue::String(value)
                }
                "BLOB" => {
                    let value = row
                        .try_get::<Vec<u8>, _>(index)
                        .map_err(|_| NativeSqliteError::internal())?;
                    accumulate_cell_bytes(result_bytes, value.len())?;
                    JsonValue::Array(value.into_iter().map(JsonValue::from).collect())
                }
                _ => return Err(NativeSqliteError::invalid_request()),
            }
        };
        decoded.insert(name.to_owned(), value);
    }
    Ok(decoded)
}

fn accumulate_cell_bytes(total: &mut usize, cell: usize) -> Result<(), NativeSqliteError> {
    if cell > MAX_CELL_BYTES {
        return Err(NativeSqliteError::invalid_request());
    }
    accumulate_result_bytes(total, cell)
}

fn accumulate_result_bytes(total: &mut usize, amount: usize) -> Result<(), NativeSqliteError> {
    *total = total
        .checked_add(amount)
        .ok_or_else(NativeSqliteError::invalid_request)?;
    if *total > MAX_RESULT_BYTES {
        return Err(NativeSqliteError::invalid_request());
    }
    Ok(())
}

async fn run_execute(
    connection: &mut SqliteConnection,
    query: &str,
    values: &[ValidatedSqlValue],
) -> Result<SqliteQueryResult, NativeSqliteError> {
    let mut statement = sqlx::query(query);
    for value in values {
        statement = match value {
            ValidatedSqlValue::Null => statement.bind(None::<String>),
            ValidatedSqlValue::Text(value) => statement.bind(value),
            ValidatedSqlValue::Integer(value) => statement.bind(value),
            ValidatedSqlValue::Real(value) => statement.bind(value),
            ValidatedSqlValue::Blob(value) => statement.bind(value),
        };
    }
    statement
        .execute(&mut *connection)
        .await
        .map_err(NativeSqliteError::from_sqlx)
}

fn to_execute_result(result: SqliteQueryResult) -> Result<NativeExecuteResult, NativeSqliteError> {
    if result.rows_affected() > MAX_SAFE_JS_INTEGER as u64 {
        return Err(NativeSqliteError::invalid_request());
    }
    let last_insert_id = result.last_insert_rowid();
    if !(-MAX_SAFE_JS_INTEGER..=MAX_SAFE_JS_INTEGER).contains(&last_insert_id) {
        return Err(NativeSqliteError::invalid_request());
    }
    Ok(NativeExecuteResult {
        rows_affected: result.rows_affected(),
        last_insert_id: (last_insert_id != 0).then_some(last_insert_id),
    })
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut token = String::with_capacity(bytes.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        token.push(char::from(HEX[usize::from(byte >> 4)]));
        token.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    token
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(std::path::PathBuf);

    impl TestDirectory {
        fn create() -> Self {
            let path = std::env::temp_dir().join(format!(
                "inkshadow-native-sqlite-{}-{}",
                std::process::id(),
                random_token()
            ));
            std::fs::create_dir(&path).expect("create test-owned directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn managed_pre_restore_backup_destination_is_unique_and_app_owned() {
        let directory = TestDirectory::create();
        let first = managed_pre_restore_backup_destination_at(directory.path())
            .expect("first managed pre-restore destination");
        let second = managed_pre_restore_backup_destination_at(directory.path())
            .expect("second managed pre-restore destination");
        let expected_parent = directory
            .path()
            .canonicalize()
            .expect("canonical test directory")
            .join(PRE_RESTORE_BACKUP_DIRECTORY)
            .join(PRE_RESTORE_BACKUP_VERSION_DIRECTORY);

        assert_eq!(first.parent(), Some(expected_parent.as_path()));
        assert_eq!(second.parent(), Some(expected_parent.as_path()));
        assert_ne!(first, second);
        assert!(!first.exists());
        assert!(!second.exists());
        assert!(first
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(
                |name| name.starts_with("inkshadow-pre-restore-") && name.ends_with(".db")
            ));
    }

    async fn open_memory() -> (NativeSqliteBridge, String) {
        let mut bridge = NativeSqliteBridge::default();
        let receipt = bridge
            .open_options(
                SqliteConnectOptions::new()
                    .in_memory(true)
                    .foreign_keys(true)
                    .journal_mode(SqliteJournalMode::Memory)
                    .synchronous(SqliteSynchronous::Normal)
                    .busy_timeout(Duration::from_secs(1)),
                false,
            )
            .await
            .expect("open in-memory bridge");
        (bridge, receipt.session_token)
    }

    fn integer(value: i64) -> NativeSqlValue {
        NativeSqlValue::Integer { value }
    }

    async fn open_migrated_state(directory: &TestDirectory) -> (NativeSqliteState, String) {
        let state = NativeSqliteState::default();
        let receipt = state
            .inner
            .lock()
            .await
            .open_file(&directory.path().join("dispatch-lease.db"))
            .await
            .expect("open fully migrated dispatch database");
        (state, receipt.session_token)
    }

    fn dispatch_receipt(
        project_id: &str,
        chapters: Vec<NativeProjectContextChapterAuthority>,
    ) -> NativeProjectContextPrivacyReceipt {
        let mut receipt = NativeProjectContextPrivacyReceipt {
            schema_version: 1,
            project_id: project_id.to_owned(),
            fingerprint: String::new(),
            active_chapter_count: chapters
                .iter()
                .filter(|chapter| chapter.status == "active")
                .count(),
            retained_chapter_count: chapters.len(),
            requires_verified_local: chapters
                .iter()
                .any(|chapter| chapter.privacy_mode == "local_only"),
            chapters,
        };
        receipt.fingerprint =
            canonical_project_context_fingerprint(&receipt).expect("canonical fingerprint");
        receipt
    }

    #[test]
    fn canonical_project_context_fingerprint_matches_cross_language_golden() {
        let receipt = NativeProjectContextPrivacyReceipt {
            schema_version: 1,
            project_id: "019f9f4a-b3c7-7350-9226-000000000001".to_owned(),
            fingerprint: String::new(),
            active_chapter_count: 1,
            retained_chapter_count: 2,
            requires_verified_local: true,
            chapters: vec![
                NativeProjectContextChapterAuthority {
                    chapter_id: "019f9f4a-b3c7-7350-9226-000000000002".to_owned(),
                    current_version_id: "019f9f4a-b3c7-7350-9226-000000000004".to_owned(),
                    revision: 2,
                    privacy_revision: 3,
                    privacy_mode: "standard".to_owned(),
                    status: "active".to_owned(),
                },
                NativeProjectContextChapterAuthority {
                    chapter_id: "019f9f4a-b3c7-7350-9226-000000000003".to_owned(),
                    current_version_id: "019f9f4a-b3c7-7350-9226-000000000005".to_owned(),
                    revision: 7,
                    privacy_revision: 8,
                    privacy_mode: "local_only".to_owned(),
                    status: "trashed".to_owned(),
                },
            ],
        };

        assert_eq!(
            canonical_project_context_fingerprint(&receipt).as_deref(),
            Some("753e6be487ad58ca9953b20d3e27a8cbc4c27fcba281cffa557e074040520ee3")
        );
    }

    async fn seed_dispatch_project(
        state: &NativeSqliteState,
        project_id: &str,
        chapter_id: Option<&str>,
        version_id: Option<&str>,
        privacy_mode: &str,
    ) {
        let mut bridge = state.inner.lock().await;
        let connection = bridge.connection_mut().expect("migrated connection");
        sqlx::query("BEGIN")
            .execute(&mut *connection)
            .await
            .expect("begin seed");
        sqlx::query(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (?, ?, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
        )
        .bind(project_id)
        .bind(project_id)
        .execute(&mut *connection)
        .await
        .expect("seed project");
        if let (Some(chapter_id), Some(version_id)) = (chapter_id, version_id) {
            sqlx::query(
                "INSERT INTO chapters (
                   id, project_id, title, content, current_version_id,
                   created_at, updated_at, privacy_mode, privacy_revision
                 ) VALUES (?, ?, 'Chapter', '', ?,
                   '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', ?, 1)",
            )
            .bind(chapter_id)
            .bind(project_id)
            .bind(version_id)
            .bind(privacy_mode)
            .execute(&mut *connection)
            .await
            .expect("seed chapter");
            sqlx::query(
                "INSERT INTO chapter_versions (
                   id, project_id, chapter_id, sequence, reason, content,
                   content_checksum, created_at
                 ) VALUES (?, ?, ?, 1, 'created', '', ?, '2026-08-08T00:00:00.000Z')",
            )
            .bind(version_id)
            .bind(project_id)
            .bind(chapter_id)
            .bind("a".repeat(64))
            .execute(&mut *connection)
            .await
            .expect("seed version");
        }
        sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .expect("commit seed");
    }

    #[test]
    fn maps_busy_and_disk_full_extended_codes_without_exposing_engine_text() {
        let busy = NativeSqliteError::from_sqlite_extended_code(Some(5));
        assert_eq!(busy.code, "SQLITE_BUSY");
        assert!(busy.retryable);

        let busy_snapshot = NativeSqliteError::from_sqlite_extended_code(Some(517));
        assert_eq!(busy_snapshot.code, "SQLITE_BUSY");
        assert!(busy_snapshot.retryable);

        let disk_full = NativeSqliteError::from_sqlite_extended_code(Some(13));
        assert_eq!(disk_full.code, "SQLITE_DISK_FULL");
        assert!(!disk_full.retryable);

        let corrupt = NativeSqliteError::from_sqlite_extended_code(Some(11));
        assert_eq!(corrupt.code, "SQLITE_DATABASE_CORRUPT");
        assert!(!corrupt.retryable);

        let not_a_database = NativeSqliteError::from_sqlite_extended_code(Some(26));
        assert_eq!(not_a_database.code, "SQLITE_DATABASE_CORRUPT");
        assert!(!not_a_database.retryable);

        let unknown = NativeSqliteError::from_sqlite_extended_code(Some(10));
        assert_eq!(unknown.code, "SQLITE_OPERATION_FAILED");
    }

    #[tokio::test]
    async fn bounded_bridge_lock_reports_not_started_without_invalidating_the_owner() {
        let state = NativeSqliteState {
            bridge_lock_timeout: Duration::from_millis(5),
            ..NativeSqliteState::default()
        };
        let owner = state.inner.lock().await;

        let error = match state.lock_bridge("execute_lock").await {
            Ok(_) => panic!("contended bridge lock must time out"),
            Err(error) => error,
        };
        assert_eq!(error.code, "SQLITE_OPERATION_TIMEOUT");
        assert_eq!(error.stage, Some("execute_lock"));
        assert_eq!(error.outcome, Some("not_started"));
        assert!(owner.connection.is_none());
    }

    #[tokio::test]
    async fn timed_out_write_and_commit_drop_the_handle_and_keep_sanitized_outcomes_distinct() {
        for error in [
            NativeSqliteError::write_outcome_unknown("execute"),
            NativeSqliteError::commit_outcome_unknown(),
        ] {
            let (mut bridge, _) = open_memory().await;
            let result = fail_bounded_bridge_operation::<()>(&mut bridge, error);
            let failure = result.expect_err("timeout must fail closed");
            assert!(bridge.connection.is_none());
            assert!(bridge.session_token.is_none());
            assert!(bridge.transaction.is_none());
            assert_eq!(failure.outcome, Some("unknown"));
            assert!(matches!(
                failure.code,
                "SQLITE_WRITE_OUTCOME_UNKNOWN" | "SQLITE_COMMIT_OUTCOME_UNKNOWN"
            ));
            let diagnostic = serde_json::to_value(&failure).expect("serialize diagnostic");
            assert!(diagnostic.get("query").is_none());
            assert!(diagnostic.get("path").is_none());
            assert!(diagnostic.get("values").is_none());
        }
    }

    #[tokio::test]
    async fn maps_a_real_sqlite_page_limit_exhaustion_and_keeps_the_database_valid() {
        let directory = TestDirectory::create();
        let database_path = directory.path().join("page-limit-full.db");
        let mut connection = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Delete)
                .synchronous(SqliteSynchronous::Full),
        )
        .await
        .expect("open isolated page-limit database");
        sqlx::query("PRAGMA page_size = 512")
            .execute(&mut connection)
            .await
            .expect("set the test page size before schema allocation");
        sqlx::query("VACUUM")
            .execute(&mut connection)
            .await
            .expect("materialize the test page size");
        sqlx::query("CREATE TABLE payloads (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)")
            .execute(&mut connection)
            .await
            .expect("create the bounded test table");
        sqlx::query("PRAGMA max_page_count = 8")
            .execute(&mut connection)
            .await
            .expect("apply an isolated SQLite page ceiling");

        let mapped = loop {
            match sqlx::query("INSERT INTO payloads (payload) VALUES (zeroblob(4096))")
                .execute(&mut connection)
                .await
            {
                Ok(_) => continue,
                Err(error) => break NativeSqliteError::from_sqlx(error),
            }
        };

        assert_eq!(mapped.code, "SQLITE_DISK_FULL");
        assert!(!mapped.retryable);
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA quick_check")
                .fetch_one(&mut connection)
                .await
                .expect("the failed write must leave a valid database"),
            "ok"
        );
    }

    #[test]
    fn path_ticket_errors_expose_only_a_stable_generic_diagnostic() {
        assert_eq!(
            serde_json::to_value(NativeSqliteError::invalid_path_ticket())
                .expect("serialize path-ticket error"),
            serde_json::json!({
                "code": "SQLITE_PATH_TICKET_INVALID",
                "message": "The selected local database file authorization is invalid or expired.",
                "retryable": false
            })
        );
    }

    #[tokio::test]
    async fn remote_dispatch_lease_binds_exact_authority_and_blocks_privacy_taint() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000001";
        const CHAPTER_ID: &str = "019f9f4a-b3c7-7350-9226-000000000002";
        const VERSION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000003";
        let directory = TestDirectory::create();
        let (state, _) = open_migrated_state(&directory).await;
        seed_dispatch_project(
            &state,
            PROJECT_ID,
            Some(CHAPTER_ID),
            Some(VERSION_ID),
            "standard",
        )
        .await;
        let receipt = dispatch_receipt(
            PROJECT_ID,
            vec![NativeProjectContextChapterAuthority {
                chapter_id: CHAPTER_ID.to_owned(),
                current_version_id: VERSION_ID.to_owned(),
                revision: 1,
                privacy_revision: 1,
                privacy_mode: "standard".to_owned(),
                status: "active".to_owned(),
            }],
        );

        let lease = state
            .acquire_project_remote_dispatch_lease(&receipt, false, "generation", "generation-1")
            .await
            .expect("exact authority acquires a lease");
        let mut bridge = state.inner.lock().await;
        sqlx::query(
            "UPDATE chapters SET content = 'autosave', revision = revision + 1 WHERE id = ?",
        )
        .bind(CHAPTER_ID)
        .execute(bridge.connection_mut().expect("connection"))
        .await
        .expect("ordinary content writes remain available");
        let error = sqlx::query("UPDATE chapters SET privacy_mode = 'local_only' WHERE id = ?")
            .bind(CHAPTER_ID)
            .execute(bridge.connection_mut().expect("connection"))
            .await
            .expect_err("privacy taint must wait for the network future");
        assert_eq!(
            NativeSqliteError::from_sqlx(error).code,
            "PROJECT_REMOTE_DISPATCH_ACTIVE"
        );
        let archive_error = sqlx::query(
            "UPDATE projects
             SET status = 'archived', archived_at = '2026-08-08T00:01:00.000Z'
             WHERE id = ?",
        )
        .bind(PROJECT_ID)
        .execute(bridge.connection_mut().expect("connection"))
        .await
        .expect_err("project archive must wait for the complete native dispatch future");
        assert_eq!(
            NativeSqliteError::from_sqlx(archive_error).code,
            "PROJECT_REMOTE_DISPATCH_ACTIVE"
        );
        let delete_error = sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(PROJECT_ID)
            .execute(bridge.connection_mut().expect("connection"))
            .await
            .expect_err("project deletion must wait for the complete native dispatch future");
        assert_eq!(
            NativeSqliteError::from_sqlx(delete_error).code,
            "PROJECT_REMOTE_DISPATCH_ACTIVE"
        );
        let maintenance_error = bridge
            .ensure_no_project_remote_dispatch_leases()
            .await
            .expect_err("restore and close must wait for the full network future");
        assert_eq!(maintenance_error.code, "PROJECT_REMOTE_DISPATCH_ACTIVE");
        drop(bridge);

        state
            .release_project_remote_dispatch_lease(&lease)
            .await
            .expect("release exact lease");
        let mut bridge = state.inner.lock().await;
        sqlx::query(
            "UPDATE projects
             SET status = 'archived', archived_at = '2026-08-08T00:01:00.000Z'
             WHERE id = ?",
        )
        .bind(PROJECT_ID)
        .execute(bridge.connection_mut().expect("connection"))
        .await
        .expect("archive succeeds after the native dispatch lease is released");
    }

    #[tokio::test]
    async fn two_connections_close_both_w_before_l_and_l_before_w_races() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000031";
        const CHAPTER_ID: &str = "019f9f4a-b3c7-7350-9226-000000000032";
        const VERSION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000033";
        let directory = TestDirectory::create();
        let database_path = directory.path().join("dispatch-lease.db");
        let (state, _) = open_migrated_state(&directory).await;
        seed_dispatch_project(
            &state,
            PROJECT_ID,
            Some(CHAPTER_ID),
            Some(VERSION_ID),
            "standard",
        )
        .await;
        let receipt = dispatch_receipt(
            PROJECT_ID,
            vec![NativeProjectContextChapterAuthority {
                chapter_id: CHAPTER_ID.to_owned(),
                current_version_id: VERSION_ID.to_owned(),
                revision: 1,
                privacy_revision: 1,
                privacy_mode: "standard".to_owned(),
                status: "active".to_owned(),
            }],
        );
        let mut writer = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(false)
                .foreign_keys(true)
                .journal_mode(SqliteJournalMode::Wal)
                .busy_timeout(Duration::from_secs(1)),
        )
        .await
        .expect("open independent writer connection");

        // W before L: acquisition recomputes authority after the committed
        // privacy write and therefore cannot dispatch the stale receipt.
        sqlx::query("UPDATE chapters SET privacy_mode = 'local_only' WHERE id = ?")
            .bind(CHAPTER_ID)
            .execute(&mut writer)
            .await
            .expect("privacy write wins before lease");
        assert_eq!(
            state
                .acquire_project_remote_dispatch_lease(&receipt, false, "generation", "w-before-l",)
                .await
                .expect_err("stale standard authority must not acquire"),
            ProjectRemoteDispatchLeaseError::AuthorityChanged
        );
        sqlx::query("UPDATE chapters SET privacy_mode = 'standard' WHERE id = ?")
            .bind(CHAPTER_ID)
            .execute(&mut writer)
            .await
            .expect("restore standard fixture");

        // L before W: BEGIN IMMEDIATE commits the durable barrier before the
        // network future starts, so the independent writer hits the trigger.
        let lease = state
            .acquire_project_remote_dispatch_lease(&receipt, false, "generation", "l-before-w")
            .await
            .expect("lease wins before privacy write");
        let blocked = sqlx::query("UPDATE chapters SET privacy_mode = 'local_only' WHERE id = ?")
            .bind(CHAPTER_ID)
            .execute(&mut writer)
            .await
            .expect_err("active lease must reject the losing privacy write");
        assert!(blocked
            .as_database_error()
            .is_some_and(|error| error.message().contains("INKSHADOW_REMOTE_DISPATCH_ACTIVE")));
        sqlx::query("UPDATE chapters SET content = 'still editable' WHERE id = ?")
            .bind(CHAPTER_ID)
            .execute(&mut writer)
            .await
            .expect("ordinary正文 write remains available during dispatch");
        state
            .release_project_remote_dispatch_lease(&lease)
            .await
            .expect("release winning lease");
        sqlx::query("UPDATE chapters SET privacy_mode = 'local_only' WHERE id = ?")
            .bind(CHAPTER_ID)
            .execute(&mut writer)
            .await
            .expect("delayed privacy change succeeds after release");
    }

    #[tokio::test]
    async fn remote_dispatch_authority_fails_closed_but_allows_an_existing_empty_project() {
        const EMPTY_PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000011";
        const MISSING_PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000012";
        let directory = TestDirectory::create();
        let (state, _) = open_migrated_state(&directory).await;
        seed_dispatch_project(&state, EMPTY_PROJECT_ID, None, None, "standard").await;

        let empty = dispatch_receipt(EMPTY_PROJECT_ID, vec![]);
        let lease = state
            .acquire_project_remote_dispatch_lease(&empty, false, "embedding", "embedding-1")
            .await
            .expect("an existing empty project is a legal project context");
        state
            .release_project_remote_dispatch_lease(&lease)
            .await
            .expect("release empty project lease");

        let missing = dispatch_receipt(MISSING_PROJECT_ID, vec![]);
        assert_eq!(
            state
                .acquire_project_remote_dispatch_lease(&missing, false, "rerank", "rerank-1")
                .await
                .expect_err("a nonexistent project must fail closed"),
            ProjectRemoteDispatchLeaseError::AuthorityChanged
        );
        let mut changed = empty.clone();
        changed.fingerprint = "0".repeat(64);
        assert_eq!(
            state
                .acquire_project_remote_dispatch_lease(
                    &changed,
                    false,
                    "generation",
                    "generation-2",
                )
                .await
                .expect_err("a forged fingerprint must fail closed"),
            ProjectRemoteDispatchLeaseError::AuthorityChanged
        );
    }

    #[tokio::test]
    async fn project_dispatch_requires_an_active_project_and_allows_private_context_only_locally() {
        const ACTIVE_PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000041";
        const ACTIVE_CHAPTER_ID: &str = "019f9f4a-b3c7-7350-9226-000000000042";
        const ACTIVE_VERSION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000043";
        const ARCHIVED_PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000044";
        let directory = TestDirectory::create();
        let (state, _) = open_migrated_state(&directory).await;
        seed_dispatch_project(
            &state,
            ACTIVE_PROJECT_ID,
            Some(ACTIVE_CHAPTER_ID),
            Some(ACTIVE_VERSION_ID),
            "local_only",
        )
        .await;
        seed_dispatch_project(&state, ARCHIVED_PROJECT_ID, None, None, "standard").await;
        {
            let mut bridge = state.inner.lock().await;
            sqlx::query(
                "UPDATE projects
                 SET status = 'archived', archived_at = '2026-08-08T00:01:00.000Z'
                 WHERE id = ?",
            )
            .bind(ARCHIVED_PROJECT_ID)
            .execute(bridge.connection_mut().expect("connection"))
            .await
            .expect("archive fixture project before dispatch");
        }

        let private_receipt = dispatch_receipt(
            ACTIVE_PROJECT_ID,
            vec![NativeProjectContextChapterAuthority {
                chapter_id: ACTIVE_CHAPTER_ID.to_owned(),
                current_version_id: ACTIVE_VERSION_ID.to_owned(),
                revision: 1,
                privacy_revision: 1,
                privacy_mode: "local_only".to_owned(),
                status: "active".to_owned(),
            }],
        );
        assert_eq!(
            state
                .acquire_project_remote_dispatch_lease(
                    &private_receipt,
                    false,
                    "generation",
                    "remote-private",
                )
                .await
                .expect_err("remote dispatch must reject private chapter context"),
            ProjectRemoteDispatchLeaseError::PrivateChapterLocalOnly
        );
        let local_lease = state
            .acquire_project_remote_dispatch_lease(
                &private_receipt,
                true,
                "generation",
                "local-private",
            )
            .await
            .expect(
                "verified loopback dispatch retains a lifecycle lease and may use private text",
            );
        state
            .release_project_remote_dispatch_lease(&local_lease)
            .await
            .expect("release local project-context lease");

        let archived_receipt = dispatch_receipt(ARCHIVED_PROJECT_ID, vec![]);
        assert_eq!(
            state
                .acquire_project_remote_dispatch_lease(
                    &archived_receipt,
                    true,
                    "embedding",
                    "archived-local",
                )
                .await
                .expect_err("an archived project cannot dispatch even to loopback"),
            ProjectRemoteDispatchLeaseError::AuthorityChanged
        );
    }

    #[tokio::test]
    async fn reconciliation_removes_only_operations_proven_inactive_by_native_registry() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000021";
        let directory = TestDirectory::create();
        let (state, _) = open_migrated_state(&directory).await;
        seed_dispatch_project(&state, PROJECT_ID, None, None, "standard").await;
        let receipt = dispatch_receipt(PROJECT_ID, vec![]);
        state
            .acquire_project_remote_dispatch_lease(&receipt, false, "generation", "generation-live")
            .await
            .expect("acquire live lease");
        state
            .acquire_project_remote_dispatch_lease(&receipt, false, "embedding", "embedding-ended")
            .await
            .expect("acquire ended lease");

        let active = HashSet::from(["generation-live".to_owned()]);
        assert_eq!(
            state
                .reconcile_project_remote_dispatch_leases(&active)
                .await
                .expect("reconcile leases"),
            1
        );
        let mut bridge = state.inner.lock().await;
        let remaining = sqlx::query_scalar::<_, String>(
            "SELECT operation_id FROM project_remote_dispatch_leases",
        )
        .fetch_all(bridge.connection_mut().expect("connection"))
        .await
        .expect("list remaining leases");
        assert_eq!(remaining, vec!["generation-live"]);
    }

    #[tokio::test]
    async fn startup_reconciliation_removes_old_owners_once_without_touching_current_owner() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000041";
        let directory = TestDirectory::create();
        let (state, _) = open_migrated_state(&directory).await;
        seed_dispatch_project(&state, PROJECT_ID, None, None, "standard").await;
        let mut bridge = state.inner.lock().await;
        let connection = bridge.connection_mut().expect("connection");
        for (lease_id, operation_id, owner) in [
            (
                "019f9f4a-b3c7-7350-9226-000000000042",
                "old-operation",
                "previous-runtime-owner",
            ),
            (
                "019f9f4a-b3c7-7350-9226-000000000043",
                "current-operation",
                state.runtime_id.as_ref(),
            ),
        ] {
            sqlx::query(
                "INSERT INTO project_remote_dispatch_leases (
                   lease_id, project_id, operation_kind, operation_id, owner_runtime_id,
                   authority_fingerprint, acquired_at, network_deadline_at
                 ) VALUES (?, ?, 'generation', ?, ?, ?,
                   '2026-08-08T00:00:00.000Z', '2026-08-08T00:12:00.000Z')",
            )
            .bind(lease_id)
            .bind(PROJECT_ID)
            .bind(operation_id)
            .bind(owner)
            .bind("a".repeat(64))
            .execute(&mut *connection)
            .await
            .expect("seed startup lease");
        }
        state
            .reconcile_startup_project_remote_dispatch_leases(connection)
            .await
            .expect("first startup reconciliation");
        let remaining = sqlx::query_scalar::<_, String>(
            "SELECT operation_id FROM project_remote_dispatch_leases ORDER BY operation_id",
        )
        .fetch_all(&mut *connection)
        .await
        .expect("remaining startup leases");
        assert_eq!(remaining, vec!["current-operation"]);

        sqlx::query(
            "INSERT INTO project_remote_dispatch_leases (
               lease_id, project_id, operation_kind, operation_id, owner_runtime_id,
               authority_fingerprint, acquired_at, network_deadline_at
             ) VALUES (?, ?, 'generation', 'late-old-operation', 'previous-runtime-owner', ?,
               '2026-08-08T00:00:00.000Z', '2026-08-08T00:12:00.000Z')",
        )
        .bind("019f9f4a-b3c7-7350-9226-000000000044")
        .bind(PROJECT_ID)
        .bind("a".repeat(64))
        .execute(&mut *connection)
        .await
        .expect("seed row after first open");
        state
            .reconcile_startup_project_remote_dispatch_leases(connection)
            .await
            .expect("repeated open reconciliation is a no-op");
        let count =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM project_remote_dispatch_leases")
                .fetch_one(&mut *connection)
                .await
                .expect("count repeated-open leases");
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn rejects_checksum_mismatch_without_replacing_the_original_database() {
        let directory = TestDirectory::create();
        let database_path = directory.path().join("checksum-mismatch.db");
        let mut bridge = NativeSqliteBridge::default();
        let session = bridge
            .open_file(&database_path)
            .await
            .expect("apply the pinned migration set")
            .session_token;
        bridge
            .execute(
                &session,
                "CREATE TABLE migration_integrity_sentinel (value TEXT NOT NULL)",
                vec![],
            )
            .await
            .expect("create sentinel");
        bridge
            .execute(
                &session,
                "INSERT INTO migration_integrity_sentinel (value) VALUES ('preserved')",
                vec![],
            )
            .await
            .expect("write sentinel");
        bridge
            .execute(
                &session,
                "UPDATE _sqlx_migrations SET checksum = x'00' WHERE version = 1",
                vec![],
            )
            .await
            .expect("tamper migration history");
        bridge.close().await.expect("close before integrity check");

        let error = bridge
            .open_file(&database_path)
            .await
            .expect_err("checksum mismatch must be terminal");
        assert_eq!(error.code, "SQLITE_MIGRATION_INTEGRITY_FAILED");
        assert!(!error.retryable);
        let diagnostic = serde_json::to_value(&error).expect("serialize migration diagnostic");
        assert_eq!(
            diagnostic.get("stage").and_then(JsonValue::as_str),
            Some("migration_history_validation")
        );
        assert_eq!(
            diagnostic.get("reasonCode").and_then(JsonValue::as_str),
            Some("MIGRATION_CHECKSUM_UNKNOWN")
        );
        assert_eq!(
            diagnostic
                .get("expectedVersion")
                .and_then(JsonValue::as_i64),
            Some(81)
        );
        assert_eq!(
            diagnostic
                .get("nativeErrorClass")
                .and_then(JsonValue::as_str),
            Some("MIGRATE_VERSION_MISMATCH")
        );
        assert!(diagnostic
            .get("sqlitePrimaryCode")
            .is_some_and(JsonValue::is_null));
        assert!(diagnostic
            .get("sqliteExtendedCode")
            .is_some_and(JsonValue::is_null));
        assert_eq!(
            diagnostic
                .get("causeChain")
                .and_then(JsonValue::as_array)
                .expect("safe cause chain")
                .iter()
                .filter_map(JsonValue::as_str)
                .collect::<Vec<_>>(),
            vec![
                "LocalMigrationError",
                "MigrateError::VersionMismatch",
                "MIGRATION_CHECKSUM_UNKNOWN"
            ]
        );
        assert_eq!(
            diagnostic.get("actualVersion").and_then(JsonValue::as_i64),
            Some(81)
        );
        assert_eq!(
            diagnostic
                .get("migrationVersion")
                .and_then(JsonValue::as_i64),
            Some(1)
        );
        assert!(diagnostic.get("path").is_none());
        assert!(diagnostic.get("sql").is_none());
        assert!(diagnostic.get("content").is_none());
        assert!(bridge.connection.is_none());
        assert!(bridge.session_token.is_none());
        assert!(database_path.is_file());

        let mut inspection = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(false),
        )
        .await
        .expect("reopen the preserved original for inspection");
        let sentinel: String = sqlx::query_scalar("SELECT value FROM migration_integrity_sentinel")
            .fetch_one(&mut inspection)
            .await
            .expect("original application data remains");
        let checksum: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = 1")
                .fetch_one(&mut inspection)
                .await
                .expect("original migration history remains");
        assert_eq!(sentinel, "preserved");
        assert_eq!(checksum, vec![0]);
        inspection.close().await.expect("close inspection");
    }

    #[tokio::test]
    async fn classifies_read_only_migration_failure_and_preserves_the_database() {
        let directory = TestDirectory::create();
        let database_path = directory.path().join("read-only-migration.db");
        let mut writable = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(true),
        )
        .await
        .expect("create read-only migration fixture");
        sqlx::query(
            "CREATE TABLE startup_sentinel (
               id INTEGER PRIMARY KEY,
               value TEXT NOT NULL
             )",
        )
        .execute(&mut writable)
        .await
        .expect("create preserved sentinel table");
        sqlx::query("INSERT INTO startup_sentinel (id, value) VALUES (1, ?)")
            .bind("PRIVATE_PROSE_MARKER")
            .execute(&mut writable)
            .await
            .expect("insert preserved sentinel row");
        writable.close().await.expect("close writable fixture");
        let original_bytes = std::fs::read(&database_path).expect("read original fixture bytes");

        let mut read_only = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(false)
                .read_only(true),
        )
        .await
        .expect("open fixture in SQLite read-only mode");
        let migration_error = run_local_migrations(&mut read_only)
            .await
            .expect_err("forward migration must fail on a read-only database");
        let error = NativeSqliteError::from_migrate(migration_error);
        assert_eq!(error.code, "SQLITE_READ_ONLY");
        assert!(!error.retryable);
        assert_eq!(error.stage, Some("migration_apply"));

        let diagnostic = serde_json::to_value(&error).expect("serialize read-only diagnostic");
        assert_eq!(
            diagnostic
                .get("nativeErrorClass")
                .and_then(JsonValue::as_str),
            Some("SQLITE_READ_ONLY")
        );
        assert_eq!(
            diagnostic
                .get("sqlitePrimaryCode")
                .and_then(JsonValue::as_u64),
            Some(8)
        );
        assert_eq!(
            diagnostic
                .get("sqliteExtendedCode")
                .and_then(JsonValue::as_u64)
                .map(|code| code & 0xff),
            Some(8)
        );
        let causes = diagnostic
            .get("causeChain")
            .and_then(JsonValue::as_array)
            .expect("read-only cause chain")
            .iter()
            .filter_map(JsonValue::as_str)
            .collect::<Vec<_>>();
        assert_eq!(causes.first().copied(), Some("LocalMigrationError"));
        assert!(causes.iter().any(|cause| matches!(
            *cause,
            "MigrateError::Execute" | "MigrateError::ExecuteMigration"
        )));
        assert!(causes.contains(&"SqlxError::Database"));
        assert!(causes.contains(&"SQLITE_READ_ONLY"));
        let serialized = serde_json::to_string(&error).expect("serialize safe diagnostic text");
        assert!(!serialized.contains("PRIVATE_PROSE_MARKER"));
        assert!(!serialized.contains("read-only-migration.db"));
        assert!(!serialized.contains("startup_sentinel"));
        assert!(diagnostic.get("path").is_none());
        assert!(diagnostic.get("sql").is_none());
        assert!(diagnostic.get("content").is_none());

        let sentinel: String =
            sqlx::query_scalar("SELECT value FROM startup_sentinel WHERE id = 1")
                .fetch_one(&mut read_only)
                .await
                .expect("read preserved sentinel through read-only connection");
        assert_eq!(sentinel, "PRIVATE_PROSE_MARKER");
        read_only.close().await.expect("close read-only fixture");
        assert_eq!(
            std::fs::read(&database_path).expect("read preserved fixture bytes"),
            original_bytes
        );
    }

    #[tokio::test]
    async fn classifies_controlled_sqlite_page_exhaustion_without_losing_existing_rows() {
        let directory = TestDirectory::create();
        let database_path = directory.path().join("page-limit-migration.db");
        let mut connection = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(true),
        )
        .await
        .expect("create controlled page-limit fixture");
        sqlx::query("PRAGMA page_size = 512")
            .execute(&mut connection)
            .await
            .expect("set small deterministic page size");
        sqlx::query(
            "CREATE TABLE startup_sentinel (
               id INTEGER PRIMARY KEY,
               value TEXT NOT NULL
             )",
        )
        .execute(&mut connection)
        .await
        .expect("create sentinel before exhausting pages");
        sqlx::query("INSERT INTO startup_sentinel (id, value) VALUES (1, 'preserved')")
            .execute(&mut connection)
            .await
            .expect("insert sentinel before exhausting pages");
        let initial_pages: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(&mut connection)
            .await
            .expect("read initial page count");
        let maximum_pages: i64 =
            sqlx::query_scalar(&format!("PRAGMA max_page_count = {}", initial_pages + 2))
                .fetch_one(&mut connection)
                .await
                .expect("set controlled SQLite page limit");
        assert_eq!(maximum_pages, initial_pages + 2);

        let migration_error = run_local_migrations(&mut connection)
            .await
            .expect_err("published migrations must exceed the controlled page limit");
        let error = NativeSqliteError::from_migrate(migration_error);
        assert_eq!(error.code, "SQLITE_DISK_FULL");
        assert!(!error.retryable);
        assert_eq!(error.stage, Some("migration_apply"));

        let diagnostic = serde_json::to_value(&error).expect("serialize page-limit diagnostic");
        assert_eq!(
            diagnostic
                .get("nativeErrorClass")
                .and_then(JsonValue::as_str),
            Some("SQLITE_FULL")
        );
        assert_eq!(
            diagnostic
                .get("sqlitePrimaryCode")
                .and_then(JsonValue::as_u64),
            Some(13)
        );
        assert_eq!(
            diagnostic
                .get("sqliteExtendedCode")
                .and_then(JsonValue::as_u64)
                .map(|code| code & 0xff),
            Some(13)
        );
        let causes = diagnostic
            .get("causeChain")
            .and_then(JsonValue::as_array)
            .expect("page-limit cause chain")
            .iter()
            .filter_map(JsonValue::as_str)
            .collect::<Vec<_>>();
        assert!(causes.iter().any(|cause| matches!(
            *cause,
            "MigrateError::Execute" | "MigrateError::ExecuteMigration"
        )));
        assert!(causes.contains(&"SqlxError::Database"));
        assert!(causes.contains(&"SQLITE_FULL"));
        let sentinel: String =
            sqlx::query_scalar("SELECT value FROM startup_sentinel WHERE id = 1")
                .fetch_one(&mut connection)
                .await
                .expect("existing user row remains readable after page exhaustion");
        assert_eq!(sentinel, "preserved");
        connection.close().await.expect("close page-limit fixture");
    }

    #[tokio::test]
    async fn classifies_corrupt_database_as_terminal_and_preserves_its_bytes() {
        let directory = TestDirectory::create();
        let database_path = directory.path().join("corrupt.db");
        let original = b"not-an-inkshadow-sqlite-database".to_vec();
        std::fs::write(&database_path, &original).expect("write corrupt fixture");

        let mut bridge = NativeSqliteBridge::default();
        let error = bridge
            .open_file(&database_path)
            .await
            .expect_err("invalid SQLite file must fail closed");
        assert_eq!(error.code, "SQLITE_DATABASE_CORRUPT");
        assert!(!error.retryable);
        assert!(bridge.connection.is_none());
        assert!(bridge.session_token.is_none());
        assert_eq!(
            std::fs::read(&database_path).expect("read preserved corrupt fixture"),
            original
        );
    }

    #[tokio::test]
    async fn commits_and_rolls_back_on_the_same_connection() {
        let (mut bridge, session) = open_memory().await;
        bridge
            .execute(
                &session,
                "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
                vec![],
            )
            .await
            .expect("create table");

        let committed = bridge.begin(&session, false).await.expect("begin");
        bridge
            .transaction_execute(
                &session,
                &committed,
                "INSERT INTO records (id, value) VALUES (?, ?)",
                vec![integer(1), NativeSqlValue::Text { value: "a".into() }],
            )
            .await
            .expect("insert");
        let visible_inside_transaction = bridge
            .transaction_select(
                &session,
                &committed,
                "SELECT value FROM records WHERE id = 1",
                vec![],
            )
            .await
            .expect("select after write");
        assert_eq!(
            visible_inside_transaction[0].get("value"),
            Some(&JsonValue::from("a"))
        );
        bridge
            .finish_transaction(&session, &committed, true)
            .await
            .expect("commit");

        let rolled_back = bridge.begin(&session, false).await.expect("begin");
        bridge
            .transaction_execute(
                &session,
                &rolled_back,
                "INSERT INTO records (id, value) VALUES (?, ?)",
                vec![integer(2), NativeSqlValue::Text { value: "b".into() }],
            )
            .await
            .expect("insert");
        bridge
            .finish_transaction(&session, &rolled_back, false)
            .await
            .expect("rollback");

        let rows = bridge
            .select(
                &session,
                "SELECT id, value FROM records ORDER BY id",
                vec![],
            )
            .await
            .expect("select");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("id"), Some(&JsonValue::from(1)));
    }

    #[tokio::test]
    async fn enforces_foreign_keys_and_blocks_normal_operations_during_transactions() {
        let (mut bridge, session) = open_memory().await;
        bridge
            .execute(
                &session,
                "CREATE TABLE parents (id INTEGER PRIMARY KEY)",
                vec![],
            )
            .await
            .expect("create parent");
        bridge
            .execute(
                &session,
                "CREATE TABLE children (parent_id INTEGER NOT NULL REFERENCES parents(id))",
                vec![],
            )
            .await
            .expect("create child");

        let token = bridge.begin(&session, false).await.expect("begin");
        assert_eq!(
            bridge
                .select(&session, "SELECT 1 AS value", vec![])
                .await
                .expect_err("normal query blocked")
                .code,
            "SQLITE_TRANSACTION_ACTIVE"
        );
        assert!(bridge
            .transaction_execute(
                &session,
                &token,
                "INSERT INTO children (parent_id) VALUES (?)",
                vec![integer(99)],
            )
            .await
            .is_err());
        bridge
            .finish_transaction(&session, &token, false)
            .await
            .expect("rollback");

        let foreign_keys = bridge
            .select(&session, "PRAGMA foreign_keys", vec![])
            .await
            .expect("foreign keys");
        assert_eq!(
            foreign_keys[0].get("foreign_keys"),
            Some(&JsonValue::from(1))
        );
    }

    #[tokio::test]
    async fn permits_foreign_key_deferral_only_inside_a_transaction_and_enforces_it_on_commit() {
        let (mut bridge, session) = open_memory().await;
        bridge
            .execute(
                &session,
                "CREATE TABLE parents (id INTEGER PRIMARY KEY)",
                vec![],
            )
            .await
            .expect("create parent");
        bridge
            .execute(
                &session,
                "CREATE TABLE children (parent_id INTEGER NOT NULL REFERENCES parents(id))",
                vec![],
            )
            .await
            .expect("create child");

        assert_eq!(
            bridge
                .execute(&session, "PRAGMA defer_foreign_keys = ON", vec![])
                .await
                .expect_err("deferral outside a transaction must be rejected")
                .code,
            "SQLITE_REQUEST_INVALID"
        );

        let token = bridge.begin(&session, false).await.expect("begin");
        bridge
            .transaction_execute(&session, &token, "PRAGMA defer_foreign_keys = ON", vec![])
            .await
            .expect("defer transaction foreign keys");
        bridge
            .transaction_execute(
                &session,
                &token,
                "INSERT INTO children (parent_id) VALUES (1)",
                vec![],
            )
            .await
            .expect("temporarily unresolved child");
        bridge
            .transaction_execute(
                &session,
                &token,
                "INSERT INTO parents (id) VALUES (1)",
                vec![],
            )
            .await
            .expect("resolve parent");
        bridge
            .finish_transaction(&session, &token, true)
            .await
            .expect("commit resolved graph");

        let rows = bridge
            .select(&session, "SELECT parent_id FROM children", vec![])
            .await
            .expect("read restored child");
        assert_eq!(rows[0].get("parent_id"), Some(&JsonValue::from(1)));

        let invalid_token = bridge.begin(&session, false).await.expect("begin invalid");
        bridge
            .transaction_execute(
                &session,
                &invalid_token,
                "PRAGMA defer_foreign_keys = ON",
                vec![],
            )
            .await
            .expect("defer invalid transaction");
        bridge
            .transaction_execute(
                &session,
                &invalid_token,
                "INSERT INTO children (parent_id) VALUES (99)",
                vec![],
            )
            .await
            .expect("temporarily unresolved child");
        bridge
            .finish_transaction(&session, &invalid_token, true)
            .await
            .expect_err("commit must enforce deferred constraints");
    }

    #[tokio::test]
    async fn rejects_wrong_tokens_and_read_only_mutations_then_restores_writes() {
        let (mut bridge, session) = open_memory().await;
        bridge
            .execute(
                &session,
                "CREATE TABLE records (id INTEGER PRIMARY KEY)",
                vec![],
            )
            .await
            .expect("create table");
        bridge
            .execute(&session, "INSERT INTO records (id) VALUES (1)", vec![])
            .await
            .expect("seed");

        let token = bridge.begin(&session, true).await.expect("begin");
        assert_eq!(
            bridge
                .transaction_select(&session, &random_token(), "SELECT 1 AS value", vec![],)
                .await
                .expect_err("wrong token")
                .code,
            "SQLITE_TRANSACTION_INVALID"
        );
        assert_eq!(
            bridge
                .transaction_execute(
                    &session,
                    &token,
                    "INSERT INTO records (id) VALUES (1)",
                    vec![],
                )
                .await
                .expect_err("read-only")
                .code,
            "SQLITE_TRANSACTION_READ_ONLY"
        );
        assert!(bridge
            .transaction_select(
                &session,
                &token,
                "WITH marker AS (SELECT 1) DELETE FROM records WHERE id = 1 RETURNING id",
                vec![],
            )
            .await
            .is_err());
        bridge
            .finish_transaction(&session, &token, true)
            .await
            .expect("commit read");
        let rows = bridge
            .select(&session, "SELECT id FROM records ORDER BY id", vec![])
            .await
            .expect("read after read-only transaction");
        assert_eq!(rows.len(), 1);
        bridge
            .execute(&session, "INSERT INTO records (id) VALUES (2)", vec![])
            .await
            .expect("write restored");
    }

    #[tokio::test]
    async fn close_rolls_back_orphaned_transactions_and_invalidates_the_session() {
        let (mut bridge, session) = open_memory().await;
        bridge
            .execute(
                &session,
                "CREATE TABLE records (id INTEGER PRIMARY KEY)",
                vec![],
            )
            .await
            .expect("create table");
        let token = bridge.begin(&session, false).await.expect("begin");
        bridge
            .transaction_execute(
                &session,
                &token,
                "INSERT INTO records (id) VALUES (1)",
                vec![],
            )
            .await
            .expect("insert");
        bridge.close().await.expect("close");

        assert_eq!(
            bridge
                .select(&session, "SELECT 1 AS value", vec![])
                .await
                .expect_err("old session")
                .code,
            "SQLITE_SESSION_INVALID"
        );
        let reopened = bridge
            .open_options(SqliteConnectOptions::new().in_memory(true), false)
            .await
            .expect("reopen");
        assert_ne!(reopened.session_token, session);
    }

    #[tokio::test]
    async fn webview_reload_adopts_the_connection_and_rolls_back_the_orphaned_transaction() {
        let (mut bridge, session) = open_memory().await;
        bridge
            .execute(
                &session,
                "CREATE TABLE records (id INTEGER PRIMARY KEY)",
                vec![],
            )
            .await
            .expect("create table");
        bridge
            .execute(&session, "INSERT INTO records (id) VALUES (1)", vec![])
            .await
            .expect("seed committed row");
        let transaction = bridge.begin(&session, false).await.expect("begin orphan");
        bridge
            .transaction_execute(
                &session,
                &transaction,
                "INSERT INTO records (id) VALUES (2)",
                vec![],
            )
            .await
            .expect("insert orphaned row");

        let adopted = bridge
            .adopt_renderer_session()
            .await
            .expect("adopt existing native connection");

        assert_ne!(adopted.session_token, session);
        assert_eq!(
            bridge
                .select(&session, "SELECT id FROM records", vec![])
                .await
                .expect_err("old renderer session must be invalid")
                .code,
            "SQLITE_SESSION_INVALID"
        );
        let rows = bridge
            .select(
                &adopted.session_token,
                "SELECT id FROM records ORDER BY id",
                vec![],
            )
            .await
            .expect("read through adopted session");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("id"), Some(&JsonValue::from(1)));
    }

    #[tokio::test]
    async fn webview_reload_detaches_a_stale_restore_source_before_reusing_the_session() {
        let directory = TestDirectory::create();
        let main_path = directory.path().join("main.db");
        let backup_path = directory.path().join("backup.db");
        let mut bridge = NativeSqliteBridge::default();
        let session = bridge
            .open_file(&main_path)
            .await
            .expect("open main")
            .session_token;
        bridge
            .execute(
                &session,
                "CREATE TABLE records (id INTEGER PRIMARY KEY)",
                vec![],
            )
            .await
            .expect("create table");
        bridge
            .execute(
                &session,
                "VACUUM INTO ?",
                vec![NativeSqlValue::Text {
                    value: backup_path.to_string_lossy().into_owned(),
                }],
            )
            .await
            .expect("create backup");
        bridge
            .execute(
                &session,
                "ATTACH DATABASE ? AS restore_source",
                vec![NativeSqlValue::Text {
                    value: backup_path.to_string_lossy().into_owned(),
                }],
            )
            .await
            .expect("attach restore source");

        let adopted = bridge
            .adopt_renderer_session()
            .await
            .expect("reload must clear stale attachment");
        assert_ne!(adopted.session_token, session);
        let names = bridge.database_names().await.expect("database names");
        assert!(names.iter().any(|name| name == "main"));
        assert!(names
            .iter()
            .all(|name| matches!(name.as_str(), "main" | "temp")));
        bridge
            .select(&adopted.session_token, "SELECT id FROM records", vec![])
            .await
            .expect("reused session remains readable");
    }

    #[tokio::test]
    async fn reload_invalidates_then_reopens_when_a_stale_attachment_cannot_be_detached() {
        let directory = TestDirectory::create();
        let main_path = directory.path().join("main.db");
        let backup_path = directory.path().join("backup.db");
        let mut bridge = NativeSqliteBridge::default();
        let session = bridge
            .open_file(&main_path)
            .await
            .expect("open main")
            .session_token;
        bridge
            .execute(
                &session,
                "CREATE TABLE records (id INTEGER PRIMARY KEY)",
                vec![],
            )
            .await
            .expect("create table");
        bridge
            .execute(
                &session,
                "VACUUM INTO ?",
                vec![NativeSqlValue::Text {
                    value: backup_path.to_string_lossy().into_owned(),
                }],
            )
            .await
            .expect("create backup");
        bridge
            .execute(
                &session,
                "ATTACH DATABASE ? AS restore_source",
                vec![NativeSqlValue::Text {
                    value: backup_path.to_string_lossy().into_owned(),
                }],
            )
            .await
            .expect("attach restore source");
        bridge.fail_next_detach = true;

        assert_eq!(
            bridge
                .adopt_renderer_session()
                .await
                .expect_err("unconfirmed detach must invalidate")
                .code,
            "SQLITE_CONNECTION_INVALIDATED"
        );
        assert!(bridge.connection.is_none());
        let reopened = bridge.open_file(&main_path).await.expect("reopen main");
        assert_ne!(reopened.session_token, session);
        let names = bridge.database_names().await.expect("database names");
        assert!(names.iter().any(|name| name == "main"));
        assert!(names
            .iter()
            .all(|name| matches!(name.as_str(), "main" | "temp")));
    }

    #[tokio::test]
    async fn expires_idle_transactions_before_serving_more_work() {
        let (mut bridge, session) = open_memory().await;
        bridge
            .execute(
                &session,
                "CREATE TABLE records (id INTEGER PRIMARY KEY)",
                vec![],
            )
            .await
            .expect("create table");
        let token = bridge.begin(&session, false).await.expect("begin");
        bridge
            .transaction_execute(
                &session,
                &token,
                "INSERT INTO records (id) VALUES (1)",
                vec![],
            )
            .await
            .expect("insert");
        bridge
            .transaction
            .as_mut()
            .expect("transaction")
            .last_activity = Instant::now() - Duration::from_secs(2);
        bridge
            .expire_transaction_if_timed_out(Duration::from_secs(1), Duration::from_secs(60))
            .await
            .expect("expire");

        let rows = bridge
            .select(&session, "SELECT COUNT(*) AS count FROM records", vec![])
            .await
            .expect("select");
        assert_eq!(rows[0].get("count"), Some(&JsonValue::from(0)));
    }

    #[tokio::test]
    async fn background_expiration_uses_the_refreshed_idle_deadline() {
        let (bridge, session) = open_memory().await;
        let state = Arc::new(Mutex::new(bridge));
        let token = {
            let mut bridge = state.lock().await;
            bridge.begin(&session, false).await.expect("begin")
        };
        let idle_timeout = Duration::from_millis(40);
        schedule_transaction_expiration(
            Arc::clone(&state),
            session.clone(),
            token.clone(),
            idle_timeout,
            Duration::from_secs(60),
            Duration::from_secs(1),
            Duration::from_secs(1),
        );

        tokio::time::sleep(Duration::from_millis(25)).await;
        {
            let mut bridge = state.lock().await;
            bridge
                .transaction_select(&session, &token, "SELECT 1 AS value", vec![])
                .await
                .expect("refresh activity");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(
            state.lock().await.transaction.is_some(),
            "activity must extend the deadline"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            state.lock().await.transaction.is_none(),
            "the transaction expires near one refreshed timeout"
        );
    }

    #[tokio::test]
    async fn invalid_transaction_calls_do_not_refresh_idle_activity_and_lifetime_is_absolute() {
        let (mut bridge, session) = open_memory().await;
        let token = bridge.begin(&session, false).await.expect("begin");
        let activity_before = bridge
            .transaction
            .as_ref()
            .expect("transaction")
            .last_activity;

        assert_eq!(
            bridge
                .transaction_execute(&session, &token, "COMMIT", vec![])
                .await
                .expect_err("invalid transaction SQL")
                .code,
            "SQLITE_REQUEST_INVALID"
        );
        assert_eq!(
            bridge
                .transaction
                .as_ref()
                .expect("transaction")
                .last_activity,
            activity_before
        );

        {
            let transaction = bridge.transaction.as_mut().expect("transaction");
            transaction.last_activity = Instant::now();
            transaction.created_at = Instant::now() - Duration::from_secs(2);
        }
        bridge
            .expire_transaction_if_timed_out(Duration::from_secs(60), Duration::from_secs(1))
            .await
            .expect("expire at absolute lifetime");
        assert!(bridge.transaction.is_none());
        assert_eq!(
            bridge
                .transaction_select(&session, &token, "SELECT 1 AS value", vec![])
                .await
                .expect_err("expired token")
                .code,
            "SQLITE_TRANSACTION_INVALID"
        );
    }

    #[tokio::test]
    async fn round_trips_blobs_and_preserves_safe_integer_kinds() {
        let (mut bridge, session) = open_memory().await;
        bridge
            .execute(
                &session,
                "CREATE TABLE values_table (id INTEGER PRIMARY KEY, payload BLOB NOT NULL, ratio REAL NOT NULL)",
                vec![],
            )
            .await
            .expect("create");
        bridge
            .execute(
                &session,
                "INSERT INTO values_table (id, payload, ratio) VALUES (?, ?, ?)",
                vec![
                    integer(MAX_SAFE_JS_INTEGER),
                    NativeSqlValue::Blob {
                        value: vec![0, 127, 255],
                    },
                    NativeSqlValue::Real { value: 1.25 },
                ],
            )
            .await
            .expect("insert");
        let rows = bridge
            .select(
                &session,
                "SELECT id, payload, ratio FROM values_table",
                vec![],
            )
            .await
            .expect("select");
        assert_eq!(
            rows[0].get("id"),
            Some(&JsonValue::from(MAX_SAFE_JS_INTEGER))
        );
        assert_eq!(
            rows[0].get("payload"),
            Some(&JsonValue::from(vec![0_u8, 127, 255]))
        );
        assert_eq!(rows[0].get("ratio"), Some(&JsonValue::from(1.25)));
    }

    #[tokio::test]
    async fn rejects_unsafe_integer_values_and_mutating_read_queries() {
        let (mut bridge, session) = open_memory().await;
        assert_eq!(
            bridge
                .select(
                    &session,
                    "SELECT ? AS value",
                    vec![integer(MAX_SAFE_JS_INTEGER + 1)],
                )
                .await
                .expect_err("unsafe bind")
                .code,
            "SQLITE_REQUEST_INVALID"
        );
        assert_eq!(
            bridge
                .select(&session, "PRAGMA foreign_keys = OFF", vec![])
                .await
                .expect_err("mutating pragma")
                .code,
            "SQLITE_REQUEST_INVALID"
        );
        assert_eq!(
            bridge
                .select(&session, "PRAGMA foreign_keys(OFF)", vec![])
                .await
                .expect_err("parenthesized mutating pragma")
                .code,
            "SQLITE_REQUEST_INVALID"
        );
        assert_eq!(
            bridge
                .select(&session, "SELECT 1; DELETE FROM records", vec![])
                .await
                .expect_err("multiple statements")
                .code,
            "SQLITE_REQUEST_INVALID"
        );
    }

    #[tokio::test]
    async fn redacts_database_paths_and_rejects_virtual_table_bypasses() {
        let (mut bridge, session) = open_memory().await;
        let mut rows = bridge
            .select(&session, "PRAGMA database_list", vec![])
            .await
            .expect("read redacted database list");
        redact_database_list_paths("PRAGMA database_list", &mut rows);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("name"), Some(&JsonValue::from("main")));
        assert_eq!(rows[0].get("file"), Some(&JsonValue::from("native://main")));

        for query in [
            "SELECT * FROM pragma_database_list",
            "WITH databases AS (SELECT * FROM pragma_database_list) SELECT * FROM databases",
            "PRAGMA main.database_list",
        ] {
            assert_eq!(
                bridge
                    .select(&session, query, vec![])
                    .await
                    .expect_err("database path bypass must be rejected")
                    .code,
                "SQLITE_REQUEST_INVALID"
            );
        }

        let mut unknown = JsonMap::from_iter([
            ("name".to_owned(), JsonValue::from("unexpected_alias")),
            (
                "file".to_owned(),
                JsonValue::from("C:/sensitive/source.sqlite"),
            ),
        ]);
        redact_database_list_paths("PRAGMA database_list", std::slice::from_mut(&mut unknown));
        assert_eq!(
            unknown.get("file"),
            Some(&JsonValue::from("native://redacted"))
        );
    }

    #[tokio::test]
    async fn renderer_sql_cannot_observe_or_mutate_native_dispatch_leases() {
        let (mut bridge, session) = open_memory().await;
        for query in [
            "SELECT * FROM project_remote_dispatch_leases",
            "select * from main.\"PROJECT_REMOTE_DISPATCH_LEASES\"",
            "EXPLAIN SELECT * FROM [project_remote_dispatch_leases]",
            "DELETE FROM /* guarded */ `project_remote_dispatch_leases`",
            "WITH target AS (SELECT lease_id FROM project_remote_dispatch_leases) SELECT * FROM target",
            "WITH target AS (SELECT 1) DELETE FROM project_remote_dispatch_leases",
            "DROP TABLE project_remote_dispatch_leases",
            "DrOp TrIgGeR \"PROJECT_REMOTE_DISPATCH_PRIVATE_CHAPTER_UPDATE_GUARD\"",
            "DROP INDEX [project_remote_dispatch_leases_project_idx]",
        ] {
            let error = if query
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("select")
                || query.trim_start().to_ascii_lowercase().starts_with("explain")
                || (query.trim_start().to_ascii_lowercase().starts_with("with")
                    && query.to_ascii_lowercase().contains(" select * from target"))
            {
                bridge
                    .select(&session, query, vec![])
                    .await
                    .expect_err("protected lease read must be rejected")
            } else {
                bridge
                    .execute(&session, query, vec![])
                    .await
                    .expect_err("protected lease mutation must be rejected")
            };
            assert_eq!(error.code, "SQLITE_REQUEST_INVALID", "query: {query}");
        }
        bridge
            .select(
                &session,
                "SELECT 1 AS value /* project_remote_dispatch_leases */",
                vec![],
            )
            .await
            .expect("comments do not create an identifier");

        let transaction = bridge
            .begin(&session, false)
            .await
            .expect("begin transaction");
        let error = bridge
            .transaction_execute(
                &session,
                &transaction,
                "DeLeTe FROM 'project_remote_dispatch_leases'",
                vec![],
            )
            .await
            .expect_err("transaction path must enforce the same protected table boundary");
        assert_eq!(error.code, "SQLITE_REQUEST_INVALID");
        bridge
            .finish_transaction(&session, &transaction, false)
            .await
            .expect("rollback test transaction");
    }

    #[test]
    fn rejects_sql_bind_count_blob_and_numeric_limits_before_database_work() {
        assert_eq!(
            validate_request(&" ".repeat(MAX_SQL_BYTES + 1), vec![], true)
                .expect_err("SQL byte limit")
                .code,
            "SQLITE_REQUEST_INVALID"
        );
        assert_eq!(
            validate_request(
                "SELECT 1",
                vec![NativeSqlValue::Null; MAX_BIND_VALUES + 1],
                true,
            )
            .expect_err("bind count limit")
            .code,
            "SQLITE_REQUEST_INVALID"
        );
        assert_eq!(
            validate_request(
                "SELECT ?",
                vec![NativeSqlValue::Blob {
                    value: vec![-1, 256],
                }],
                true,
            )
            .expect_err("blob byte limit")
            .code,
            "SQLITE_REQUEST_INVALID"
        );
        assert_eq!(
            validate_request(
                "SELECT ?",
                vec![NativeSqlValue::Real {
                    value: f64::INFINITY,
                }],
                true,
            )
            .expect_err("finite real limit")
            .code,
            "SQLITE_REQUEST_INVALID"
        );
    }

    #[tokio::test]
    async fn rejects_transaction_control_sql_through_every_execute_path() {
        let (mut bridge, session) = open_memory().await;
        for query in [
            "BEGIN",
            "COMMIT",
            "END",
            "ROLLBACK",
            "SAVEPOINT nested",
            "RELEASE nested",
        ] {
            assert_eq!(
                bridge
                    .execute(&session, query, vec![])
                    .await
                    .expect_err("transaction control must be rejected")
                    .code,
                "SQLITE_REQUEST_INVALID"
            );
        }
        for (query, values) in [
            (
                "ATTACH DATABASE ? AS arbitrary_alias",
                vec![NativeSqlValue::Text {
                    value: "file:C:/example.db?mode=ro".into(),
                }],
            ),
            (
                "ATTACH DATABASE ? AS restore_source",
                vec![NativeSqlValue::Text {
                    value: "file:C:/example.db?mode=ro".into(),
                }],
            ),
            ("DETACH DATABASE arbitrary_alias", vec![]),
            ("VACUUM", vec![]),
        ] {
            assert_eq!(
                bridge
                    .execute(&session, query, values)
                    .await
                    .expect_err("generic maintenance SQL must be rejected")
                    .code,
                "SQLITE_REQUEST_INVALID"
            );
        }

        let token = bridge.begin(&session, false).await.expect("begin");
        assert_eq!(
            bridge
                .transaction_execute(&session, &token, "COMMIT", vec![])
                .await
                .expect_err("transaction command must be rejected")
                .code,
            "SQLITE_REQUEST_INVALID"
        );
        assert_eq!(
            bridge
                .transaction_execute(
                    &session,
                    &token,
                    "ATTACH DATABASE ? AS restore_source",
                    vec![NativeSqlValue::Text {
                        value: "file:C:/example.db?mode=ro".into(),
                    }],
                )
                .await
                .expect_err("maintenance SQL is never accepted inside a transaction")
                .code,
            "SQLITE_REQUEST_INVALID"
        );
        bridge
            .finish_transaction(&session, &token, false)
            .await
            .expect("rollback");
    }

    #[tokio::test]
    async fn reports_unknown_commit_when_transaction_state_cannot_be_recovered() {
        let (mut bridge, session) = open_memory().await;
        let token = bridge.begin(&session, false).await.expect("begin");

        sqlx::query("ROLLBACK")
            .execute(bridge.connection_mut().expect("connection"))
            .await
            .expect("force external rollback");
        assert_eq!(
            bridge
                .finish_transaction(&session, &token, true)
                .await
                .expect_err("commit state is unknown")
                .code,
            "SQLITE_COMMIT_OUTCOME_UNKNOWN"
        );
        assert!(bridge.connection.is_none());
        assert!(bridge.session_token.is_none());
        assert!(bridge.transaction.is_none());
    }

    #[tokio::test]
    async fn reports_unknown_commit_when_post_commit_cleanup_cannot_be_confirmed() {
        let (mut bridge, session) = open_memory().await;
        let token = bridge.begin(&session, true).await.expect("begin read");
        bridge.fail_next_query_only_restore = true;

        let error = bridge
            .finish_transaction(&session, &token, true)
            .await
            .expect_err("successful commit with failed cleanup must be unresolved");
        assert_eq!(error.code, "SQLITE_COMMIT_OUTCOME_UNKNOWN");
        assert_eq!(error.stage, Some("transaction_commit"));
        assert_eq!(error.outcome, Some("unknown"));
        assert!(!error.retryable);
        assert!(bridge.connection.is_none());
        assert!(bridge.session_token.is_none());
        assert!(bridge.transaction.is_none());
    }

    #[tokio::test]
    async fn invalidates_a_session_when_post_read_configuration_is_not_restored() {
        let (mut bridge, session) = open_memory().await;
        bridge.fail_next_query_only_restore = true;

        assert_eq!(
            bridge
                .select(&session, "SELECT 1 AS value", vec![])
                .await
                .expect_err("configuration must fail closed")
                .code,
            "SQLITE_CONNECTION_INVALIDATED"
        );
        assert!(bridge.connection.is_none());
        assert!(bridge.session_token.is_none());
    }

    #[tokio::test]
    async fn invalidates_when_begin_or_idle_rollback_cannot_restore_query_only() {
        let (mut bridge, session) = open_memory().await;
        bridge.fail_next_begin = true;
        bridge.fail_next_query_only_restore = true;
        assert_eq!(
            bridge
                .begin(&session, true)
                .await
                .expect_err("failed begin restoration")
                .code,
            "SQLITE_CONNECTION_INVALIDATED"
        );
        assert!(bridge.connection.is_none());

        let reopened = bridge
            .open_options(SqliteConnectOptions::new().in_memory(true), false)
            .await
            .expect("reopen");
        let session = reopened.session_token;
        bridge.begin(&session, true).await.expect("begin read");
        bridge.fail_next_query_only_restore = true;

        assert_eq!(
            bridge
                .rollback_expired_transaction()
                .await
                .expect_err("idle rollback restoration")
                .code,
            "SQLITE_CONNECTION_INVALIDATED"
        );
        assert!(bridge.connection.is_none());
        assert!(bridge.session_token.is_none());
    }

    #[tokio::test]
    async fn classifies_post_write_configuration_failure_as_unknown_and_invalidates() {
        let (mut bridge, session) = open_memory().await;
        bridge
            .execute(
                &session,
                "CREATE TABLE records (id INTEGER PRIMARY KEY)",
                vec![],
            )
            .await
            .expect("create");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(bridge.connection_mut().expect("connection"))
            .await
            .expect("inject configuration fault");
        assert_eq!(
            bridge
                .execute(&session, "INSERT INTO records (id) VALUES (1)", vec![])
                .await
                .expect_err("post execute safety verification")
                .code,
            "SQLITE_WRITE_OUTCOME_UNKNOWN"
        );
        assert!(bridge.connection.is_none());
        assert!(bridge.session_token.is_none());

        let session = bridge
            .open_options(SqliteConnectOptions::new().in_memory(true), false)
            .await
            .expect("reopen")
            .session_token;
        bridge
            .execute(
                &session,
                "CREATE TABLE records (id INTEGER PRIMARY KEY)",
                vec![],
            )
            .await
            .expect("create");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(bridge.connection_mut().expect("connection"))
            .await
            .expect("inject transaction configuration fault");
        let token = bridge.begin(&session, false).await.expect("begin");
        assert_eq!(
            bridge
                .transaction_execute(
                    &session,
                    &token,
                    "INSERT INTO records (id) VALUES (1)",
                    vec![],
                )
                .await
                .expect_err("post transaction execute safety verification")
                .code,
            "SQLITE_CONNECTION_INVALIDATED"
        );
        assert!(bridge.connection.is_none());
        assert!(bridge.session_token.is_none());
        assert!(bridge.transaction.is_none());
    }

    #[tokio::test]
    async fn keeps_backup_attach_restore_and_detach_on_one_real_file_connection() {
        let directory = TestDirectory::create();
        let main_path = directory.path().join("main.db");
        let backup_path = directory.path().join("backup 100% # 墨影.db");
        let mut bridge = NativeSqliteBridge::default();
        let session = bridge
            .open_file(&main_path)
            .await
            .expect("open main file")
            .session_token;
        let connection = bridge.connection_mut().expect("configured connection");
        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&mut *connection)
            .await
            .expect("journal mode");
        let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
            .fetch_one(&mut *connection)
            .await
            .expect("synchronous");
        let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
            .fetch_one(&mut *connection)
            .await
            .expect("busy timeout");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(synchronous, 1);
        assert!(busy_timeout >= 5_000);
        bridge
            .execute(
                &session,
                "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
                vec![],
            )
            .await
            .expect("create table");
        bridge
            .execute(
                &session,
                "INSERT INTO records (id, value) VALUES (?, ?)",
                vec![
                    integer(1),
                    NativeSqlValue::Text {
                        value: "original".into(),
                    },
                ],
            )
            .await
            .expect("seed");

        bridge
            .execute(
                &session,
                "VACUUM INTO ?",
                vec![NativeSqlValue::Text {
                    value: backup_path.to_string_lossy().into_owned(),
                }],
            )
            .await
            .expect("backup");
        bridge
            .execute(
                &session,
                "UPDATE records SET value = ? WHERE id = ?",
                vec![
                    NativeSqlValue::Text {
                        value: "changed".into(),
                    },
                    integer(1),
                ],
            )
            .await
            .expect("change main");
        bridge
            .execute(
                &session,
                "ATTACH DATABASE ? AS restore_source",
                vec![NativeSqlValue::Text {
                    value: backup_path.to_string_lossy().into_owned(),
                }],
            )
            .await
            .expect("attach");
        let attached = bridge
            .select(
                &session,
                "SELECT value FROM restore_source.records WHERE id = 1",
                vec![],
            )
            .await
            .expect("read attachment");
        assert_eq!(attached[0].get("value"), Some(&JsonValue::from("original")));

        let rollback_token = bridge.begin(&session, false).await.expect("begin restore");
        bridge
            .transaction_execute(
                &session,
                &rollback_token,
                "DELETE FROM main.records",
                vec![],
            )
            .await
            .expect("delete main");
        bridge
            .transaction_execute(
                &session,
                &rollback_token,
                "INSERT INTO main.records SELECT * FROM restore_source.records",
                vec![],
            )
            .await
            .expect("copy backup");
        assert!(bridge
            .transaction_execute(
                &session,
                &rollback_token,
                "INSERT INTO main.records (id, value) VALUES (1, 'duplicate')",
                vec![],
            )
            .await
            .is_err());
        bridge
            .finish_transaction(&session, &rollback_token, false)
            .await
            .expect("rollback failed restore");
        let unchanged = bridge
            .select(
                &session,
                "SELECT value FROM main.records WHERE id = 1",
                vec![],
            )
            .await
            .expect("read unchanged main");
        assert_eq!(unchanged[0].get("value"), Some(&JsonValue::from("changed")));

        let commit_token = bridge.begin(&session, false).await.expect("begin restore");
        bridge
            .transaction_execute(&session, &commit_token, "DELETE FROM main.records", vec![])
            .await
            .expect("delete main");
        bridge
            .transaction_execute(
                &session,
                &commit_token,
                "INSERT INTO main.records SELECT * FROM restore_source.records",
                vec![],
            )
            .await
            .expect("copy backup");
        bridge
            .finish_transaction(&session, &commit_token, true)
            .await
            .expect("commit restore");
        bridge
            .execute(&session, "DETACH DATABASE restore_source", vec![])
            .await
            .expect("detach");
        let restored = bridge
            .select(
                &session,
                "SELECT value FROM main.records WHERE id = 1",
                vec![],
            )
            .await
            .expect("read restored main");
        assert_eq!(restored[0].get("value"), Some(&JsonValue::from("original")));
        bridge.close().await.expect("close bridge");
    }

    #[tokio::test]
    async fn rejects_same_file_aliases_and_invalidates_when_detach_cannot_be_confirmed() {
        let directory = TestDirectory::create();
        let main_path = directory.path().join("main.db");
        let same_file_path = directory.path().join("main-hardlink.db");
        std::fs::File::create(&main_path).expect("create main file");
        std::fs::hard_link(&main_path, &same_file_path).expect("create hardlink");
        let encoded = readonly_sqlite_uri(&directory.path().join("name ?#% 墨影.db"))
            .expect("encode read-only URI");
        assert!(encoded.contains("%20"));
        assert!(encoded.contains("%3F"));
        assert!(encoded.contains("%23"));
        assert!(encoded.contains("%25"));
        assert_eq!(encoded.matches('?').count(), 1);
        assert_eq!(
            ensure_distinct_database_paths(&main_path, &same_file_path)
                .expect_err("hardlink must be recognized")
                .code,
            "SQLITE_REQUEST_INVALID"
        );

        let backup_path = directory.path().join("backup.db");
        let mut bridge = NativeSqliteBridge::default();
        let session = bridge
            .open_file(&main_path)
            .await
            .expect("open main")
            .session_token;
        assert_eq!(
            bridge
                .execute(
                    &session,
                    "VACUUM INTO ?",
                    vec![NativeSqlValue::Text {
                        value: same_file_path.to_string_lossy().into_owned(),
                    }],
                )
                .await
                .expect_err("same-file backup target")
                .code,
            "SQLITE_REQUEST_INVALID"
        );

        bridge
            .execute(
                &session,
                "CREATE TABLE records (id INTEGER PRIMARY KEY)",
                vec![],
            )
            .await
            .expect("create table");
        bridge
            .execute(
                &session,
                "VACUUM INTO ?",
                vec![NativeSqlValue::Text {
                    value: backup_path.to_string_lossy().into_owned(),
                }],
            )
            .await
            .expect("create distinct backup");
        bridge
            .execute(
                &session,
                "ATTACH DATABASE ? AS restore_source",
                vec![NativeSqlValue::Text {
                    value: backup_path.to_string_lossy().into_owned(),
                }],
            )
            .await
            .expect("attach distinct backup");

        bridge.fail_next_detach = true;
        assert_eq!(
            bridge
                .execute(&session, "DETACH DATABASE restore_source", vec![])
                .await
                .expect_err("unconfirmed detach must invalidate")
                .code,
            "SQLITE_CONNECTION_INVALIDATED"
        );
        assert!(bridge.connection.is_none());
        assert!(bridge.session_token.is_none());
        assert!(bridge.transaction.is_none());
    }
}
