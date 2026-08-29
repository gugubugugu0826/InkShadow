mod automatic_backup;
mod cloud_session;
mod local_migrations;
mod model_gateway;
mod native_export_artifact;
mod native_sqlite;
mod network_egress;
mod path_tickets;
mod project_keys;
mod secure_updater;
mod system_capacity;

use automatic_backup::{
    native_automatic_backup_acquire_lease, native_automatic_backup_create_verified,
    native_automatic_backup_delete_file, native_automatic_backup_inspect_file,
    native_automatic_backup_inspect_root, native_automatic_backup_read_manifest,
    native_automatic_backup_release_lease, native_automatic_backup_write_manifest,
};
use cloud_session::{
    accept_current_device_team_project_key_envelope_from_cloud, clear_cloud_session,
    get_cloud_session_status, inspect_stored_team_project_key_receipt, login_cloud_identity,
    logout_cloud_session, open_stored_team_project_key_receipt, refresh_cloud_session,
    remove_stored_team_project_key_receipt, send_cloud_api_request,
    send_cloud_deletion_credential_request, verify_cloud_identity_email, CloudSessionVaultState,
};
use model_gateway::{
    cancel_native_generation, check_native_model_connection, choose_native_image_destination,
    embed_native_model, generate_native_image_to_file, list_native_models,
    reconcile_native_model_dispatch_leases, rerank_native_model, start_native_generation,
    CommandError, ModelGatewayState, NativeImageDestinationState,
};
use native_export_artifact::{
    native_choose_export_destination, native_open_export_artifact, native_write_export_artifact,
    NativeExportDestinationState,
};
use native_sqlite::{
    native_choose_backup_destination, native_choose_pre_restore_backup_destination,
    native_choose_restore_source, native_sqlite_begin, native_sqlite_close, native_sqlite_commit,
    native_sqlite_execute, native_sqlite_open, native_sqlite_rollback, native_sqlite_select,
    native_sqlite_transaction_execute, native_sqlite_transaction_select, NativeSqliteState,
};
use path_tickets::PathTicketState;
use project_keys::{
    create_device_identity, create_project_recovery_kit, generate_project_data_key,
    get_device_identity_status, recover_project_data_key,
    rewrap_project_data_key_for_team_recipients, unwrap_project_data_key_for_device,
    verify_project_recovery_kit, wrap_project_data_key_for_device, ProjectKeyVaultState,
};
use secure_updater::{
    check_for_signed_update, inspect_secure_update_configuration, stage_signed_update,
    SecureUpdaterState,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
};
use system_capacity::inspect_native_model_capacity;
use tauri::Manager;
use zeroize::Zeroizing;

const PRODUCTION_CREDENTIAL_SERVICE: &str = "com.inkshadow.desktop";
const MAX_CREDENTIAL_SERVICE_BYTES: usize = 128;
const MAX_DISCOVERED_MODEL_CREDENTIALS: usize = 100;
const MAX_DISCOVERY_EXCLUDED_CREDENTIALS: usize = 10_000;
static CREDENTIAL_SERVICE: OnceLock<String> = OnceLock::new();

#[derive(Default)]
struct CredentialDiscoveryState {
    providers_by_discovery_id: Mutex<HashMap<String, String>>,
}

fn validated_credential_service(identifier: &str) -> Result<String, &'static str> {
    let valid = !identifier.is_empty()
        && identifier.len() <= MAX_CREDENTIAL_SERVICE_BYTES
        && identifier
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character));
    if valid {
        Ok(identifier.to_owned())
    } else {
        Err("the Tauri application identifier is not a safe credential service")
    }
}

fn initialize_credential_service(identifier: &str) -> Result<(), &'static str> {
    let service = validated_credential_service(identifier)?;
    if let Some(current) = CREDENTIAL_SERVICE.get() {
        return if current == &service {
            Ok(())
        } else {
            Err("the credential service was already initialized for another application")
        };
    }
    CREDENTIAL_SERVICE
        .set(service)
        .map_err(|_| "the credential service could not be initialized")
}

pub(crate) fn credential_service() -> &'static str {
    CREDENTIAL_SERVICE
        .get()
        .map(String::as_str)
        .expect("credential service must be initialized before native commands run")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretSummary {
    configured: bool,
    last_four: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveredModelCredentialSummary {
    discovery_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_connection_id: Option<String>,
    last_four: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    app_version: &'static str,
    os: &'static str,
    arch: &'static str,
    debug: bool,
}

pub(crate) fn credential_account(provider_id: &str) -> Result<String, CommandError> {
    let valid = !provider_id.is_empty()
        && provider_id.len() <= 128
        && provider_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character));

    if valid {
        Ok(format!("model:{provider_id}"))
    } else {
        Err(CommandError::new(
            "MODEL_PROVIDER_ID_INVALID",
            "The model provider identifier is invalid.",
            false,
            vec!["EDIT_MODEL_CONFIG"],
        ))
    }
}

pub(crate) fn credential_entry(provider_id: &str) -> Result<keyring::Entry, CommandError> {
    let account = credential_account(provider_id)?;
    keyring::Entry::new(credential_service(), &account)
        .map_err(|_| CommandError::credential_store_unavailable())
}

fn credential_discovery_pattern(service: &str) -> String {
    let mut escaped = String::with_capacity(service.len() * 2);
    for character in service.chars() {
        if "\\.^$|?*+()[]{}".contains(character) {
            escaped.push(char::from(92));
        }
        escaped.push(character);
    }
    format!("^model:[A-Za-z0-9._-]{{1,128}}[.]{}$", escaped)
}

fn model_provider_id_from_credential_target(target: &str, service: &str) -> Option<String> {
    let provider_id = target
        .strip_prefix("model:")?
        .strip_suffix(&format!(".{service}"))?;
    credential_account(provider_id).ok()?;
    Some(provider_id.to_owned())
}

fn last_four(secret: &str) -> String {
    let mut characters = secret.chars().rev().take(4).collect::<Vec<_>>();
    characters.reverse();
    characters.into_iter().collect()
}

fn canonical_model_provider_kind(provider_id: &str) -> Option<&str> {
    matches!(
        provider_id,
        "openai"
            | "deepseek"
            | "zhipu_glm"
            | "alibaba_qwen"
            | "volcengine_doubao"
            | "google_gemini"
            | "anthropic_claude"
            | "ollama"
            | "custom_openai_compatible"
    )
    .then_some(provider_id)
}

fn trusted_discovered_credential_source(
    provider_id: &str,
    provider_occurrences: usize,
) -> Option<(&str, &str)> {
    (provider_occurrences == 1)
        .then(|| canonical_model_provider_kind(provider_id))
        .flatten()
        .map(|provider_kind| (provider_kind, provider_id))
}

#[tauri::command]
fn get_runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        debug: cfg!(debug_assertions),
    }
}

#[tauri::command]
fn save_model_secret(provider_id: String, secret: String) -> Result<SecretSummary, CommandError> {
    let secret = Zeroizing::new(secret);
    validate_model_secret(secret.as_str())?;

    let entry = credential_entry(&provider_id)?;
    entry
        .set_password(secret.as_str())
        .map_err(|_| CommandError::credential_store_unavailable())?;

    Ok(SecretSummary {
        configured: true,
        last_four: Some(last_four(secret.as_str())),
    })
}

fn validate_model_secret(secret: &str) -> Result<(), CommandError> {
    if secret.trim().len() < 8
        || secret.trim().len() != secret.len()
        || secret.len() > 16_384
        || !secret.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
    {
        return Err(CommandError::new(
            "MODEL_SECRET_INVALID",
            "The API key format is invalid.",
            false,
            vec!["EDIT_API_KEY"],
        ));
    }
    Ok(())
}

#[tauri::command]
fn get_model_secret_summary(provider_id: String) -> Result<SecretSummary, CommandError> {
    let entry = credential_entry(&provider_id)?;
    match entry.get_password() {
        Ok(secret) => {
            let secret = Zeroizing::new(secret);
            Ok(SecretSummary {
                configured: true,
                last_four: Some(last_four(secret.as_str())),
            })
        }
        Err(keyring::Error::NoEntry) => Ok(SecretSummary {
            configured: false,
            last_four: None,
        }),
        Err(_) => Err(CommandError::credential_store_unavailable()),
    }
}

#[tauri::command]
fn delete_model_secret(provider_id: String) -> Result<SecretSummary, CommandError> {
    let entry = credential_entry(&provider_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(SecretSummary {
            configured: false,
            last_four: None,
        }),
        Err(_) => Err(CommandError::credential_store_unavailable()),
    }
}

fn credential_discovery_expired() -> CommandError {
    CommandError::new(
        "MODEL_CREDENTIAL_DISCOVERY_EXPIRED",
        "The discovered credential selection is no longer available.",
        true,
        vec!["RETRY"],
    )
}

fn discovered_provider_id(
    state: &CredentialDiscoveryState,
    discovery_id: &str,
) -> Result<String, CommandError> {
    state
        .providers_by_discovery_id
        .lock()
        .map_err(|_| CommandError::credential_store_unavailable())?
        .get(discovery_id)
        .cloned()
        .ok_or_else(credential_discovery_expired)
}

#[tauri::command]
fn discover_model_credentials(
    excluded_provider_ids: Vec<String>,
    state: tauri::State<'_, CredentialDiscoveryState>,
) -> Result<Vec<DiscoveredModelCredentialSummary>, CommandError> {
    if excluded_provider_ids.len() > MAX_DISCOVERY_EXCLUDED_CREDENTIALS {
        return Err(CommandError::new(
            "MODEL_CREDENTIAL_DISCOVERY_INVALID",
            "The credential discovery exclusion list is invalid.",
            false,
            vec!["RETRY"],
        ));
    }
    let excluded_provider_ids = excluded_provider_ids
        .into_iter()
        .map(|provider_id| {
            credential_account(&provider_id)?;
            Ok(provider_id)
        })
        .collect::<Result<HashSet<_>, CommandError>>()?;
    let service = credential_service();
    let pattern = credential_discovery_pattern(service);
    let _store_initializer = credential_entry("credential-discovery")?;
    let entries = keyring_core::Entry::search(&HashMap::from([("pattern", pattern.as_str())]))
        .map_err(|_| CommandError::credential_store_unavailable())?;
    let mut discovered = Vec::new();

    for entry in entries {
        let attributes = match entry.get_attributes() {
            Ok(attributes) => attributes,
            Err(keyring::Error::NoEntry) => continue,
            Err(_) => return Err(CommandError::credential_store_unavailable()),
        };
        let Some(provider_id) = attributes
            .get("target_name")
            .and_then(|target| model_provider_id_from_credential_target(target, service))
        else {
            continue;
        };
        if excluded_provider_ids.contains(&provider_id) {
            continue;
        }
        let secret = match entry.get_password() {
            Ok(secret) => Zeroizing::new(secret),
            Err(keyring::Error::NoEntry) => continue,
            Err(_) => return Err(CommandError::credential_store_unavailable()),
        };
        validate_model_secret(secret.as_str())?;
        discovered.push((provider_id, last_four(secret.as_str())));
    }

    discovered.sort_by(|left, right| left.0.cmp(&right.0));
    let provider_occurrences = discovered.iter().fold(HashMap::new(), |mut counts, item| {
        *counts.entry(item.0.clone()).or_insert(0_usize) += 1;
        counts
    });
    discovered.truncate(MAX_DISCOVERED_MODEL_CREDENTIALS);

    let mut providers = state
        .providers_by_discovery_id
        .lock()
        .map_err(|_| CommandError::credential_store_unavailable())?;
    providers.clear();
    Ok(discovered
        .into_iter()
        .map(|(provider_id, last_four)| {
            let discovery_id = uuid::Uuid::now_v7().to_string();
            let trusted_source = trusted_discovered_credential_source(
                &provider_id,
                provider_occurrences.get(&provider_id).copied().unwrap_or(0),
            );
            if trusted_source.is_some() {
                providers.insert(discovery_id.clone(), provider_id.clone());
            }
            DiscoveredModelCredentialSummary {
                discovery_id,
                last_four,
                provider_kind: trusted_source.map(|(provider_kind, _)| provider_kind.to_owned()),
                source_connection_id: trusted_source
                    .map(|(_, source_connection_id)| source_connection_id.to_owned()),
            }
        })
        .collect())
}

#[tauri::command]
fn reuse_discovered_model_secret(
    discovery_id: String,
    provider_id: String,
    state: tauri::State<'_, CredentialDiscoveryState>,
) -> Result<SecretSummary, CommandError> {
    let discovered_provider_id = discovered_provider_id(&state, &discovery_id)?;
    let source = credential_entry(&discovered_provider_id)?;
    let secret = match source.get_password() {
        Ok(secret) => Zeroizing::new(secret),
        Err(keyring::Error::NoEntry) => return Err(credential_discovery_expired()),
        Err(_) => return Err(CommandError::credential_store_unavailable()),
    };
    validate_model_secret(secret.as_str())?;
    let destination = credential_entry(&provider_id)?;
    destination
        .set_password(secret.as_str())
        .map_err(|_| CommandError::credential_store_unavailable())?;
    Ok(SecretSummary {
        configured: true,
        last_four: Some(last_four(secret.as_str())),
    })
}

#[tauri::command]
fn delete_discovered_model_secret(
    discovery_id: String,
    state: tauri::State<'_, CredentialDiscoveryState>,
) -> Result<SecretSummary, CommandError> {
    let provider_id = discovered_provider_id(&state, &discovery_id)?;
    let entry = credential_entry(&provider_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            state
                .providers_by_discovery_id
                .lock()
                .map_err(|_| CommandError::credential_store_unavailable())?
                .remove(&discovery_id);
            Ok(SecretSummary {
                configured: false,
                last_four: None,
            })
        }
        Err(_) => Err(CommandError::credential_store_unavailable()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    initialize_credential_service(context.config().identifier.as_str()).expect(
        "failed to initialize the credential service from the Tauri application identifier",
    );
    debug_assert_eq!(
        context.config().identifier == PRODUCTION_CREDENTIAL_SERVICE,
        credential_service() == PRODUCTION_CREDENTIAL_SERVICE,
    );
    let model_gateway =
        ModelGatewayState::new().expect("failed to initialize the native model gateway");

    tauri::Builder::default()
        .manage(model_gateway)
        .manage(CredentialDiscoveryState::default())
        .manage(NativeImageDestinationState::default())
        .manage(NativeExportDestinationState::default())
        .manage(CloudSessionVaultState::default())
        .manage(NativeSqliteState::default())
        .manage(PathTicketState::default())
        .manage(ProjectKeyVaultState::default())
        .manage(SecureUpdaterState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            native_automatic_backup_inspect_root,
            native_automatic_backup_acquire_lease,
            native_automatic_backup_release_lease,
            native_automatic_backup_read_manifest,
            native_automatic_backup_write_manifest,
            native_automatic_backup_create_verified,
            native_automatic_backup_inspect_file,
            native_automatic_backup_delete_file,
            get_runtime_info,
            native_choose_backup_destination,
            native_choose_restore_source,
            native_choose_pre_restore_backup_destination,
            native_sqlite_open,
            native_sqlite_select,
            native_sqlite_execute,
            native_sqlite_begin,
            native_sqlite_transaction_select,
            native_sqlite_transaction_execute,
            native_sqlite_commit,
            native_sqlite_rollback,
            native_sqlite_close,
            save_model_secret,
            get_model_secret_summary,
            delete_model_secret,
            discover_model_credentials,
            reuse_discovered_model_secret,
            delete_discovered_model_secret,
            list_native_models,
            check_native_model_connection,
            inspect_native_model_capacity,
            inspect_secure_update_configuration,
            check_for_signed_update,
            stage_signed_update,
            embed_native_model,
            rerank_native_model,
            choose_native_image_destination,
            generate_native_image_to_file,
            native_choose_export_destination,
            native_open_export_artifact,
            native_write_export_artifact,
            start_native_generation,
            cancel_native_generation,
            reconcile_native_model_dispatch_leases,
            create_device_identity,
            get_device_identity_status,
            generate_project_data_key,
            wrap_project_data_key_for_device,
            unwrap_project_data_key_for_device,
            rewrap_project_data_key_for_team_recipients,
            create_project_recovery_kit,
            verify_project_recovery_kit,
            recover_project_data_key,
            login_cloud_identity,
            verify_cloud_identity_email,
            refresh_cloud_session,
            get_cloud_session_status,
            send_cloud_api_request,
            send_cloud_deletion_credential_request,
            accept_current_device_team_project_key_envelope_from_cloud,
            inspect_stored_team_project_key_receipt,
            open_stored_team_project_key_receipt,
            remove_stored_team_project_key_receipt,
            logout_cloud_session,
            clear_cloud_session
        ])
        .run(context)
        .expect("failed to run InkShadow");
}

#[cfg(test)]
mod tests {
    use super::{
        credential_discovery_pattern, model_provider_id_from_credential_target,
        trusted_discovered_credential_source, validate_model_secret, validated_credential_service,
        DiscoveredModelCredentialSummary, PRODUCTION_CREDENTIAL_SERVICE,
    };

    #[test]
    fn credential_service_matches_the_tauri_identifier_and_rejects_unsafe_names() {
        assert_eq!(
            validated_credential_service(PRODUCTION_CREDENTIAL_SERVICE),
            Ok(PRODUCTION_CREDENTIAL_SERVICE.to_owned())
        );
        assert_eq!(
            validated_credential_service("com.inkshadow.desktop.regression.v026.20260821"),
            Ok("com.inkshadow.desktop.regression.v026.20260821".to_owned())
        );
        assert!(validated_credential_service("").is_err());
        assert!(validated_credential_service(&"a".repeat(129)).is_err());
        assert!(validated_credential_service("com.inkshadow.desktop/regression").is_err());
    }

    #[test]
    fn credential_discovery_is_anchored_to_safe_model_slots_for_this_application() {
        let service = PRODUCTION_CREDENTIAL_SERVICE;
        assert_eq!(
            credential_discovery_pattern(service),
            r"^model:[A-Za-z0-9._-]{1,128}[.]com\.inkshadow\.desktop$"
        );
        assert_eq!(
            model_provider_id_from_credential_target(
                "model:quick-key-019f.com.inkshadow.desktop",
                service,
            ),
            Some("quick-key-019f".to_owned())
        );
        for target in [
            "model:quick-key-019f.com.other.app",
            "other:quick-key-019f.com.inkshadow.desktop",
            "model:unsafe/provider.com.inkshadow.desktop",
            "model:.com.inkshadow.desktop",
            "model:quick-key-019f.com.inkshadow.desktop.evil",
        ] {
            assert_eq!(
                model_provider_id_from_credential_target(target, service),
                None,
                "target outside the exact app-owned model slot must be ignored"
            );
        }
    }

    #[test]
    fn canonical_discovered_credential_summary_includes_only_trusted_source_metadata() {
        let value = serde_json::to_value(DiscoveredModelCredentialSummary {
            discovery_id: "019f0000-0000-7000-8000-000000000001".to_owned(),
            last_four: "3172".to_owned(),
            provider_kind: Some("deepseek".to_owned()),
            source_connection_id: Some("deepseek".to_owned()),
        })
        .expect("serialize masked discovery summary");
        assert_eq!(
            value,
            serde_json::json!({
                "discoveryId": "019f0000-0000-7000-8000-000000000001",
                "lastFour": "3172",
                "providerKind": "deepseek",
                "sourceConnectionId": "deepseek"
            })
        );
        let serialized = value.to_string();
        assert!(serialized.contains("providerKind"));
        assert!(!serialized.contains("target"));
        assert!(!serialized.contains("service"));
        assert!(!serialized.contains("account"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn model_secret_validation_rejects_control_characters_without_echoing_values() {
        assert!(validate_model_secret("printable-secret-value").is_ok());
        for secret in [
            "secret\nvalue",
            "secret\rvalue",
            "secret\0value",
            "secret\tvalue",
            " leading-secret",
            "trailing-secret ",
        ] {
            let error = validate_model_secret(secret).expect_err("unsafe secret must fail");
            let serialized = serde_json::to_string(&error).expect("serialize safe error");
            assert_eq!(error.code(), "MODEL_SECRET_INVALID");
            assert!(!serialized.contains(secret));
        }
    }

    #[test]
    fn unknown_or_ambiguous_discovered_credentials_do_not_claim_a_source() {
        for (provider_id, occurrence_count) in [
            ("quick-key-019f", 1),
            ("unknown-provider", 1),
            ("deepseek", 2),
        ] {
            assert_eq!(
                trusted_discovered_credential_source(provider_id, occurrence_count),
                None,
                "unknown or ambiguous targets must not be bound to a source"
            );
        }
        for provider_id in [
            "openai",
            "deepseek",
            "zhipu_glm",
            "alibaba_qwen",
            "volcengine_doubao",
            "google_gemini",
            "anthropic_claude",
            "ollama",
            "custom_openai_compatible",
        ] {
            assert_eq!(
                trusted_discovered_credential_source(provider_id, 1),
                Some((provider_id, provider_id)),
                "every registered canonical provider has one exact source"
            );
        }

        let value = serde_json::to_value(DiscoveredModelCredentialSummary {
            discovery_id: "019f0000-0000-7000-8000-000000000002".to_owned(),
            last_four: "8421".to_owned(),
            provider_kind: None,
            source_connection_id: None,
        })
        .expect("serialize unknown-source summary");
        assert_eq!(
            value,
            serde_json::json!({
                "discoveryId": "019f0000-0000-7000-8000-000000000002",
                "lastFour": "8421"
            })
        );
        let serialized = value.to_string();
        assert!(!serialized.contains("providerKind"));
        assert!(!serialized.contains("sourceConnectionId"));
        assert!(!serialized.contains("secret"));
    }
}
