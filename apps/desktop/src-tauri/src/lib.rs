mod cloud_session;
mod local_migrations;
mod model_gateway;
mod native_sqlite;
mod network_egress;
mod path_tickets;
mod project_keys;
mod secure_updater;
mod system_capacity;

use cloud_session::{
    accept_current_device_team_project_key_envelope_from_cloud, clear_cloud_session,
    get_cloud_session_status, inspect_stored_team_project_key_receipt, login_cloud_identity,
    logout_cloud_session, open_stored_team_project_key_receipt, refresh_cloud_session,
    remove_stored_team_project_key_receipt, send_cloud_api_request,
    send_cloud_deletion_credential_request, verify_cloud_identity_email, CloudSessionVaultState,
};
use model_gateway::{
    cancel_native_generation, check_native_model_connection, embed_native_model,
    list_native_models, start_native_generation, CommandError, ModelGatewayState,
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
use system_capacity::inspect_native_model_capacity;
use tauri::Manager;
use zeroize::Zeroizing;

const CREDENTIAL_SERVICE: &str = "com.inkshadow.desktop";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretSummary {
    configured: bool,
    last_four: Option<String>,
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
    keyring::Entry::new(CREDENTIAL_SERVICE, &account)
        .map_err(|_| CommandError::credential_store_unavailable())
}

fn last_four(secret: &str) -> String {
    let mut characters = secret.chars().rev().take(4).collect::<Vec<_>>();
    characters.reverse();
    characters.into_iter().collect()
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
    if secret.trim().len() < 8 || secret.trim().len() != secret.len() || secret.len() > 16_384 {
        return Err(CommandError::new(
            "MODEL_SECRET_INVALID",
            "The API key format is invalid.",
            false,
            vec!["EDIT_API_KEY"],
        ));
    }

    let entry = credential_entry(&provider_id)?;
    entry
        .set_password(secret.as_str())
        .map_err(|_| CommandError::credential_store_unavailable())?;

    Ok(SecretSummary {
        configured: true,
        last_four: Some(last_four(secret.as_str())),
    })
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let model_gateway =
        ModelGatewayState::new().expect("failed to initialize the native model gateway");

    tauri::Builder::default()
        .manage(model_gateway)
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
            list_native_models,
            check_native_model_connection,
            inspect_native_model_capacity,
            inspect_secure_update_configuration,
            check_for_signed_update,
            stage_signed_update,
            embed_native_model,
            start_native_generation,
            cancel_native_generation,
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
        .run(tauri::generate_context!())
        .expect("failed to run InkShadow");
}
