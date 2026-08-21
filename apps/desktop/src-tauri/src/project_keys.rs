use std::{
    collections::HashSet,
    sync::{Mutex, MutexGuard},
};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use hpke::{
    aead::AesGcm128, kdf::HkdfSha256, kem::DhP256HkdfSha256, Deserializable, Kem as KemTrait,
    OpModeR, OpModeS, Serializable,
};
use rand::{rngs::StdRng, RngCore, SeedableRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use uuid::{Uuid, Version as UuidVersion};
use zeroize::Zeroizing;

use crate::{credential_service, model_gateway::CommandError};

type DeviceKem = DhP256HkdfSha256;
type DeviceKdf = HkdfSha256;
type DeviceAead = AesGcm128;
type DevicePrivateKey = <DeviceKem as KemTrait>::PrivateKey;
type DevicePublicKey = <DeviceKem as KemTrait>::PublicKey;
type HmacSha256 = Hmac<Sha256>;

const DEVICE_KEY_ALGORITHM: &str = "DHKEM-P256-HKDF-SHA256";
const DEVICE_ENVELOPE_ALGORITHM: &str = "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM";
const RECOVERY_ENVELOPE_ALGORITHM: &str = "ARGON2ID-AES256GCM";
const PRIVATE_KEY_FORMAT_PREFIX: &str = "inkshadow-device-key-v1:";
const HPKE_INFO: &[u8] = b"inkshadow.hpke.project-dek.v1";
const PROJECT_DATA_KEY_BYTES: usize = 32;
const P256_PRIVATE_KEY_BYTES: usize = 32;
const P256_PUBLIC_KEY_BYTES: usize = 65;
const HPKE_CIPHERTEXT_BYTES: usize = PROJECT_DATA_KEY_BYTES + 16;
const RECOVERY_SECRET_BYTES: usize = 32;
const RECOVERY_SALT_BYTES: usize = 16;
const RECOVERY_NONCE_BYTES: usize = 12;
const RECOVERY_DERIVED_BYTES: usize = 64;
const RECOVERY_MEMORY_KIB: u32 = 65_536;
const RECOVERY_TIME_COST: u32 = 3;
const RECOVERY_PARALLELISM: u32 = 4;
const RECOVERY_CODE_PREFIX: &str = "INK1_";
const TEAM_PROJECT_KEY_RECEIPT_KIND: &str = "team_managed_device_envelope";
const TEAM_PROJECT_KEY_RECEIPT_STORAGE_REF_PREFIX: &str = "team_project_key_receipt_v1_";
const STORED_TEAM_PROJECT_KEY_RECEIPT_PREFIX: &str = "inkshadow-team-project-key-receipt-v1:";
const MAX_STORED_TEAM_PROJECT_KEY_RECEIPT_BYTES: usize = 24 * 1024;
const MAX_TEAM_PROJECT_KEY_RECIPIENTS: usize = 10_000;
const MAX_PORTABLE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub(crate) struct ProjectKeyVaultState {
    guard: Mutex<()>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceIdentitySummary {
    pub(crate) schema_version: u8,
    pub(crate) device_id: String,
    pub(crate) algorithm: &'static str,
    pub(crate) public_key: String,
    pub(crate) public_key_fingerprint: String,
    private_key_storage: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceIdentityStatus {
    configured: bool,
    identity: Option<DeviceIdentitySummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectDataKeyMaterial {
    raw_project_data_key: String,
    project_key_fingerprint: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WrapProjectDataKeyInput {
    envelope_id: String,
    project_id: String,
    key_version: u32,
    sender_device_id: String,
    recipient_device_id: String,
    recipient_public_key: String,
    recipient_public_key_fingerprint: String,
    raw_project_data_key: String,
}

#[derive(Debug)]
struct DeviceEnvelopeTarget {
    envelope_id: String,
    project_id: String,
    key_version: u32,
    sender_device_id: String,
    recipient_device_id: String,
    recipient_public_key: String,
    recipient_public_key_fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamProjectKeyRecipientInput {
    envelope_id: String,
    membership_id: String,
    membership_revision: u64,
    assignment_id: String,
    assignment_revision: u64,
    recipient_device_id: String,
    recipient_public_key: String,
    recipient_public_key_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RewrapProjectDataKeyForTeamRecipientsInput {
    team_id: String,
    project_id: String,
    key_version: u32,
    sender_device_id: String,
    source_envelope: DeviceProjectKeyEnvelope,
    recipients: Vec<TeamProjectKeyRecipientInput>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamProjectKeyEnvelope {
    schema_version: u8,
    envelope_kind: String,
    envelope_id: String,
    team_id: String,
    project_id: String,
    key_version: u32,
    membership_id: String,
    membership_revision: u64,
    assignment_id: String,
    assignment_revision: u64,
    algorithm: String,
    sender_device_id: String,
    sender_public_key: String,
    sender_public_key_fingerprint: String,
    recipient_device_id: String,
    recipient_public_key: String,
    recipient_public_key_fingerprint: String,
    encapsulated_key: String,
    ciphertext: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
}

impl TeamProjectKeyEnvelope {
    pub(crate) fn created_at(&self) -> Option<&str> {
        self.created_at.as_deref()
    }
}

pub(crate) struct TeamProjectKeyEnvelopeExpectation<'a> {
    pub(crate) account_id: &'a str,
    pub(crate) team_id: &'a str,
    pub(crate) project_id: &'a str,
    pub(crate) key_version: u32,
    pub(crate) current_key_server_revision: u64,
    pub(crate) current_key_updated_at: &'a str,
    pub(crate) recipient_device_id: &'a str,
    pub(crate) recipient_public_key: &'a str,
    pub(crate) recipient_public_key_fingerprint: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamProjectKeyEnvelopeVerification {
    valid: bool,
    envelope_id: String,
    team_id: String,
    project_id: String,
    key_version: u32,
    current_key_server_revision: u64,
    current_key_updated_at: String,
    membership_id: String,
    membership_revision: u64,
    assignment_id: String,
    assignment_revision: u64,
    sender_device_id: String,
    sender_public_key_fingerprint: String,
    recipient_device_id: String,
    recipient_public_key_fingerprint: String,
    project_key_fingerprint: String,
    created_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamProjectKeyReceiptBinding {
    pub(crate) schema_version: u8,
    pub(crate) receipt_kind: String,
    pub(crate) team_id: String,
    pub(crate) project_id: String,
    pub(crate) key_version: u32,
    pub(crate) account_id: String,
    pub(crate) device_id: String,
    pub(crate) envelope_id: String,
    pub(crate) membership_id: String,
    pub(crate) membership_revision: u64,
    pub(crate) assignment_id: String,
    pub(crate) assignment_revision: u64,
    pub(crate) sender_device_id: String,
    pub(crate) sender_public_key_fingerprint: String,
    pub(crate) recipient_public_key_fingerprint: String,
    pub(crate) project_key_fingerprint: String,
    pub(crate) native_storage_ref: String,
    pub(crate) native_receipt_fingerprint: String,
    pub(crate) current_server_revision: u64,
    pub(crate) current_key_updated_at: String,
    pub(crate) envelope_created_at: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TeamProjectKeyReceiptWriteState {
    Created,
    AlreadyPresent,
    Updated,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamProjectKeyReceiptCommit {
    #[serde(flatten)]
    pub(crate) receipt: TeamProjectKeyReceiptBinding,
    pub(crate) native_write_state: TeamProjectKeyReceiptWriteState,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTeamProjectKeyReceipt {
    schema_version: u8,
    receipt_kind: String,
    account_id: String,
    project_key_fingerprint: String,
    current_server_revision: u64,
    current_key_updated_at: String,
    envelope: TeamProjectKeyEnvelope,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamProjectKeyReceiptStatus {
    configured: bool,
    native_receipt_fingerprint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamProjectKeyReceiptRemoval {
    removed: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceProjectKeyEnvelope {
    schema_version: u8,
    algorithm: String,
    envelope_id: String,
    project_id: String,
    key_version: u32,
    sender_device_id: String,
    sender_public_key: String,
    sender_public_key_fingerprint: String,
    recipient_device_id: String,
    recipient_public_key: String,
    recipient_public_key_fingerprint: String,
    encapsulated_key: String,
    ciphertext: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryKdfParameters {
    algorithm: String,
    version: u32,
    memory_kib: u32,
    time_cost: u32,
    parallelism: u32,
    output_bytes: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryProjectKeyEnvelope {
    schema_version: u8,
    algorithm: String,
    recovery_id: String,
    project_id: String,
    key_version: u32,
    kdf: RecoveryKdfParameters,
    salt: String,
    nonce: String,
    ciphertext: String,
    verifier: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateRecoveryKitInput {
    recovery_id: String,
    project_id: String,
    key_version: u32,
    raw_project_data_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryKit {
    recovery_code: String,
    envelope: RecoveryProjectKeyEnvelope,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VerifyRecoveryKitInput {
    recovery_code: String,
    envelope: RecoveryProjectKeyEnvelope,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryVerification {
    valid: bool,
    project_key_fingerprint: String,
}

#[tauri::command]
pub(crate) fn create_device_identity(
    state: State<'_, ProjectKeyVaultState>,
    device_id: String,
) -> Result<DeviceIdentitySummary, CommandError> {
    let _guard = lock_vault(state.inner())?;
    let device_id = validate_uuid_v7(&device_id, "DEVICE_ID_INVALID")?;
    let entry = device_identity_entry(&device_id)?;

    match entry.get_password() {
        Ok(stored) => {
            let stored = Zeroizing::new(stored);
            let private_key = decode_stored_private_key(stored.as_str())?;
            Ok(identity_summary(&device_id, &private_key))
        }
        Err(keyring::Error::NoEntry) => {
            let mut rng = StdRng::from_os_rng();
            let (private_key, _) = DeviceKem::gen_keypair(&mut rng);
            let encoded = Zeroizing::new(encode_stored_private_key(&private_key));
            entry
                .set_password(encoded.as_str())
                .map_err(|_| CommandError::credential_store_unavailable())?;
            Ok(identity_summary(&device_id, &private_key))
        }
        Err(_) => Err(CommandError::credential_store_unavailable()),
    }
}

#[tauri::command]
pub(crate) fn get_device_identity_status(
    state: State<'_, ProjectKeyVaultState>,
    device_id: String,
) -> Result<DeviceIdentityStatus, CommandError> {
    let _guard = lock_vault(state.inner())?;
    let device_id = validate_uuid_v7(&device_id, "DEVICE_ID_INVALID")?;
    let entry = device_identity_entry(&device_id)?;
    match entry.get_password() {
        Ok(stored) => {
            let stored = Zeroizing::new(stored);
            let private_key = decode_stored_private_key(stored.as_str())?;
            Ok(DeviceIdentityStatus {
                configured: true,
                identity: Some(identity_summary(&device_id, &private_key)),
            })
        }
        Err(keyring::Error::NoEntry) => Ok(DeviceIdentityStatus {
            configured: false,
            identity: None,
        }),
        Err(_) => Err(CommandError::credential_store_unavailable()),
    }
}

#[tauri::command]
pub(crate) fn generate_project_data_key() -> ProjectDataKeyMaterial {
    let mut raw_key = Zeroizing::new([0_u8; PROJECT_DATA_KEY_BYTES]);
    StdRng::from_os_rng().fill_bytes(raw_key.as_mut());
    ProjectDataKeyMaterial {
        raw_project_data_key: URL_SAFE_NO_PAD.encode(raw_key.as_slice()),
        project_key_fingerprint: sha256_hex(raw_key.as_slice()),
    }
}

#[tauri::command]
pub(crate) fn wrap_project_data_key_for_device(
    state: State<'_, ProjectKeyVaultState>,
    input: WrapProjectDataKeyInput,
) -> Result<DeviceProjectKeyEnvelope, CommandError> {
    let _guard = lock_vault(state.inner())?;
    let sender_device_id = validate_uuid_v7(&input.sender_device_id, "DEVICE_ID_INVALID")?;
    let entry = device_identity_entry(&sender_device_id)?;
    let stored = entry.get_password().map_err(|error| match error {
        keyring::Error::NoEntry => missing_device_identity(),
        _ => CommandError::credential_store_unavailable(),
    })?;
    let stored = Zeroizing::new(stored);
    let sender_private_key = decode_stored_private_key(stored.as_str())?;
    seal_device_envelope(input, &sender_private_key)
}

#[tauri::command]
pub(crate) fn unwrap_project_data_key_for_device(
    state: State<'_, ProjectKeyVaultState>,
    envelope: DeviceProjectKeyEnvelope,
) -> Result<ProjectDataKeyMaterial, CommandError> {
    let _guard = lock_vault(state.inner())?;
    let recipient_device_id = validate_uuid_v7(&envelope.recipient_device_id, "DEVICE_ID_INVALID")?;
    let entry = device_identity_entry(&recipient_device_id)?;
    let stored = entry.get_password().map_err(|error| match error {
        keyring::Error::NoEntry => missing_device_identity(),
        _ => CommandError::credential_store_unavailable(),
    })?;
    let stored = Zeroizing::new(stored);
    let recipient_private_key = decode_stored_private_key(stored.as_str())?;
    open_device_envelope(envelope, &recipient_private_key)
}

#[tauri::command]
pub(crate) fn rewrap_project_data_key_for_team_recipients(
    state: State<'_, ProjectKeyVaultState>,
    input: RewrapProjectDataKeyForTeamRecipientsInput,
) -> Result<Vec<TeamProjectKeyEnvelope>, CommandError> {
    let _guard = lock_vault(state.inner())?;
    let sender_device_id = validate_uuid_v7(&input.sender_device_id, "DEVICE_ID_INVALID")?;
    let entry = device_identity_entry(&sender_device_id)?;
    let stored = entry.get_password().map_err(|error| match error {
        keyring::Error::NoEntry => missing_device_identity(),
        _ => CommandError::credential_store_unavailable(),
    })?;
    let stored = Zeroizing::new(stored);
    let sender_private_key = decode_stored_private_key(stored.as_str())?;
    rewrap_project_data_key_for_team_recipients_inner(input, &sender_private_key)
}

pub(crate) fn accept_current_device_team_project_key_envelope(
    state: &ProjectKeyVaultState,
    envelope: TeamProjectKeyEnvelope,
    expected: TeamProjectKeyEnvelopeExpectation<'_>,
) -> Result<TeamProjectKeyReceiptCommit, CommandError> {
    let _guard = lock_vault(state)?;
    validate_uuid_v7(expected.account_id, "ACCOUNT_ID_INVALID")?;
    let recipient_device_id = validate_uuid_v7(expected.recipient_device_id, "DEVICE_ID_INVALID")?;
    let entry = device_identity_entry(&recipient_device_id)?;
    let stored = entry.get_password().map_err(|error| match error {
        keyring::Error::NoEntry => missing_device_identity(),
        _ => CommandError::credential_store_unavailable(),
    })?;
    let stored = Zeroizing::new(stored);
    let recipient_private_key = decode_stored_private_key(stored.as_str())?;
    let verification = verify_current_device_team_project_key_envelope_inner(
        &envelope,
        &recipient_private_key,
        &expected,
    )?;
    let record = StoredTeamProjectKeyReceipt {
        schema_version: 1,
        receipt_kind: TEAM_PROJECT_KEY_RECEIPT_KIND.to_owned(),
        account_id: expected.account_id.to_owned(),
        project_key_fingerprint: verification.project_key_fingerprint.clone(),
        current_server_revision: expected.current_key_server_revision,
        current_key_updated_at: expected.current_key_updated_at.to_owned(),
        envelope,
    };
    persist_team_project_key_receipt(record, verification)
}

pub(crate) fn inspect_team_project_key_receipt(
    state: &ProjectKeyVaultState,
    expected: &TeamProjectKeyReceiptBinding,
) -> Result<TeamProjectKeyReceiptStatus, CommandError> {
    let _guard = lock_vault(state)?;
    validate_team_project_key_receipt_binding(expected)?;
    let entry = team_project_key_receipt_entry(&expected.native_storage_ref)?;
    match entry.get_password() {
        Ok(value) => {
            let value = Zeroizing::new(value);
            let record = decode_stored_team_project_key_receipt(value.as_str())?;
            validate_stored_receipt_matches_binding(&record, expected)?;
            Ok(TeamProjectKeyReceiptStatus {
                configured: true,
                native_receipt_fingerprint: Some(expected.native_receipt_fingerprint.clone()),
            })
        }
        Err(keyring::Error::NoEntry) => Ok(TeamProjectKeyReceiptStatus {
            configured: false,
            native_receipt_fingerprint: None,
        }),
        Err(_) => Err(CommandError::credential_store_unavailable()),
    }
}

pub(crate) fn open_team_project_key_receipt(
    state: &ProjectKeyVaultState,
    expected: &TeamProjectKeyReceiptBinding,
) -> Result<ProjectDataKeyMaterial, CommandError> {
    let _guard = lock_vault(state)?;
    let record = read_stored_team_project_key_receipt(expected)?;
    let recipient_device_id = validate_uuid_v7(&expected.device_id, "DEVICE_ID_INVALID")?;
    let stored = device_identity_entry(&recipient_device_id)?
        .get_password()
        .map_err(|error| match error {
            keyring::Error::NoEntry => missing_device_identity(),
            _ => CommandError::credential_store_unavailable(),
        })?;
    let stored = Zeroizing::new(stored);
    let recipient_private_key = decode_stored_private_key(stored.as_str())?;
    let plaintext = open_current_device_team_project_key_envelope_inner(
        &record.envelope,
        &recipient_private_key,
        &TeamProjectKeyEnvelopeExpectation {
            account_id: &record.account_id,
            team_id: &record.envelope.team_id,
            project_id: &record.envelope.project_id,
            key_version: record.envelope.key_version,
            current_key_server_revision: record.current_server_revision,
            current_key_updated_at: &record.current_key_updated_at,
            recipient_device_id: &record.envelope.recipient_device_id,
            recipient_public_key: &record.envelope.recipient_public_key,
            recipient_public_key_fingerprint: &record.envelope.recipient_public_key_fingerprint,
        },
    )?;
    let project_key_fingerprint = sha256_hex(plaintext.as_slice());
    if project_key_fingerprint != expected.project_key_fingerprint {
        return Err(team_project_key_receipt_binding_mismatch());
    }
    Ok(ProjectDataKeyMaterial {
        raw_project_data_key: URL_SAFE_NO_PAD.encode(plaintext.as_slice()),
        project_key_fingerprint,
    })
}

pub(crate) fn remove_team_project_key_receipt_if_current(
    state: &ProjectKeyVaultState,
    expected: &TeamProjectKeyReceiptBinding,
) -> Result<TeamProjectKeyReceiptRemoval, CommandError> {
    let _guard = lock_vault(state)?;
    validate_team_project_key_receipt_binding(expected)?;
    let entry = team_project_key_receipt_entry(&expected.native_storage_ref)?;
    let stored = match entry.get_password() {
        Ok(value) => Zeroizing::new(value),
        Err(keyring::Error::NoEntry) => {
            return Ok(TeamProjectKeyReceiptRemoval { removed: false });
        }
        Err(_) => return Err(CommandError::credential_store_unavailable()),
    };
    let record = decode_stored_team_project_key_receipt(stored.as_str())?;
    validate_stored_receipt_matches_binding(&record, expected)?;
    match entry.delete_credential() {
        Ok(()) => Ok(TeamProjectKeyReceiptRemoval { removed: true }),
        Err(keyring::Error::NoEntry) => Ok(TeamProjectKeyReceiptRemoval { removed: false }),
        Err(_) => Err(CommandError::credential_store_unavailable()),
    }
}

#[tauri::command]
pub(crate) async fn create_project_recovery_kit(
    input: CreateRecoveryKitInput,
) -> Result<RecoveryKit, CommandError> {
    tauri::async_runtime::spawn_blocking(move || create_recovery_kit_inner(input))
        .await
        .map_err(|_| crypto_runtime_failed())?
}

#[tauri::command]
pub(crate) async fn verify_project_recovery_kit(
    input: VerifyRecoveryKitInput,
) -> Result<RecoveryVerification, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw_key = recover_project_data_key_inner(input)?;
        Ok(RecoveryVerification {
            valid: true,
            project_key_fingerprint: sha256_hex(raw_key.as_slice()),
        })
    })
    .await
    .map_err(|_| crypto_runtime_failed())?
}

#[tauri::command]
pub(crate) async fn recover_project_data_key(
    input: VerifyRecoveryKitInput,
) -> Result<ProjectDataKeyMaterial, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw_key = recover_project_data_key_inner(input)?;
        Ok(ProjectDataKeyMaterial {
            raw_project_data_key: URL_SAFE_NO_PAD.encode(raw_key.as_slice()),
            project_key_fingerprint: sha256_hex(raw_key.as_slice()),
        })
    })
    .await
    .map_err(|_| crypto_runtime_failed())?
}

fn lock_vault(state: &ProjectKeyVaultState) -> Result<MutexGuard<'_, ()>, CommandError> {
    state.guard.lock().map_err(|_| {
        CommandError::new(
            "PROJECT_KEY_VAULT_UNAVAILABLE",
            "The project key vault is temporarily unavailable.",
            true,
            vec!["RETRY", "OPEN_DIAGNOSTICS"],
        )
    })
}

fn device_identity_entry(device_id: &str) -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(credential_service(), &format!("device:{device_id}"))
        .map_err(|_| CommandError::credential_store_unavailable())
}

fn team_project_key_receipt_entry(storage_ref: &str) -> Result<keyring::Entry, CommandError> {
    validate_team_project_key_receipt_storage_ref(storage_ref)?;
    keyring::Entry::new(credential_service(), storage_ref)
        .map_err(|_| CommandError::credential_store_unavailable())
}

fn persist_team_project_key_receipt(
    record: StoredTeamProjectKeyReceipt,
    verification: TeamProjectKeyEnvelopeVerification,
) -> Result<TeamProjectKeyReceiptCommit, CommandError> {
    validate_stored_team_project_key_receipt(&record)?;
    let native_storage_ref = team_project_key_receipt_storage_ref(&record);
    let (encoded, native_receipt_fingerprint) = encode_stored_team_project_key_receipt(&record)?;
    let receipt = team_project_key_receipt_binding(
        &record,
        native_storage_ref.clone(),
        native_receipt_fingerprint.clone(),
    )?;
    if receipt.project_key_fingerprint != verification.project_key_fingerprint
        || receipt.envelope_id != verification.envelope_id
        || receipt.team_id != verification.team_id
        || receipt.project_id != verification.project_id
        || receipt.key_version != verification.key_version
        || receipt.current_server_revision != verification.current_key_server_revision
        || receipt.current_key_updated_at != verification.current_key_updated_at
        || receipt.membership_id != verification.membership_id
        || receipt.membership_revision != verification.membership_revision
        || receipt.assignment_id != verification.assignment_id
        || receipt.assignment_revision != verification.assignment_revision
        || receipt.sender_device_id != verification.sender_device_id
        || receipt.sender_public_key_fingerprint != verification.sender_public_key_fingerprint
        || receipt.device_id != verification.recipient_device_id
        || receipt.recipient_public_key_fingerprint != verification.recipient_public_key_fingerprint
        || receipt.envelope_created_at != verification.created_at
        || !verification.valid
    {
        return Err(team_project_key_receipt_corrupted());
    }

    let entry = team_project_key_receipt_entry(&native_storage_ref)?;
    let native_write_state = match entry.get_password() {
        Err(keyring::Error::NoEntry) => {
            entry
                .set_password(encoded.as_str())
                .map_err(|_| CommandError::credential_store_unavailable())?;
            TeamProjectKeyReceiptWriteState::Created
        }
        Ok(current) => {
            let current = Zeroizing::new(current);
            let current_record = decode_stored_team_project_key_receipt(current.as_str())?;
            if team_project_key_receipt_storage_ref(&current_record) != native_storage_ref {
                return Err(team_project_key_receipt_corrupted());
            }
            let (canonical_current, _) = encode_stored_team_project_key_receipt(&current_record)?;
            if canonical_current.as_str() != current.as_str() {
                return Err(team_project_key_receipt_corrupted());
            }
            match classify_team_project_key_receipt_write(
                &current_record,
                &record,
                current.as_str() == encoded.as_str(),
            )? {
                TeamProjectKeyReceiptWriteState::AlreadyPresent => {
                    TeamProjectKeyReceiptWriteState::AlreadyPresent
                }
                TeamProjectKeyReceiptWriteState::Updated => {
                    entry
                        .set_password(encoded.as_str())
                        .map_err(|_| CommandError::credential_store_unavailable())?;
                    TeamProjectKeyReceiptWriteState::Updated
                }
                TeamProjectKeyReceiptWriteState::Created => {
                    return Err(team_project_key_receipt_corrupted());
                }
            }
        }
        Err(_) => return Err(CommandError::credential_store_unavailable()),
    };
    Ok(TeamProjectKeyReceiptCommit {
        receipt,
        native_write_state,
    })
}

fn classify_team_project_key_receipt_write(
    current: &StoredTeamProjectKeyReceipt,
    incoming: &StoredTeamProjectKeyReceipt,
    exact_encoded_match: bool,
) -> Result<TeamProjectKeyReceiptWriteState, CommandError> {
    if current.current_server_revision > incoming.current_server_revision
        || (current.current_server_revision < incoming.current_server_revision
            && current.current_key_updated_at > incoming.current_key_updated_at)
    {
        return Err(team_project_key_receipt_rollback_blocked());
    }
    if current.current_server_revision == incoming.current_server_revision {
        if current.current_key_updated_at > incoming.current_key_updated_at {
            return Err(team_project_key_receipt_rollback_blocked());
        }
        return if exact_encoded_match {
            Ok(TeamProjectKeyReceiptWriteState::AlreadyPresent)
        } else {
            Err(team_project_key_receipt_conflict())
        };
    }
    Ok(TeamProjectKeyReceiptWriteState::Updated)
}

fn read_stored_team_project_key_receipt(
    expected: &TeamProjectKeyReceiptBinding,
) -> Result<StoredTeamProjectKeyReceipt, CommandError> {
    validate_team_project_key_receipt_binding(expected)?;
    let stored = team_project_key_receipt_entry(&expected.native_storage_ref)?
        .get_password()
        .map_err(|error| match error {
            keyring::Error::NoEntry => team_project_key_receipt_missing(),
            _ => CommandError::credential_store_unavailable(),
        })?;
    let stored = Zeroizing::new(stored);
    let record = decode_stored_team_project_key_receipt(stored.as_str())?;
    validate_stored_receipt_matches_binding(&record, expected)?;
    Ok(record)
}

fn encode_stored_team_project_key_receipt(
    record: &StoredTeamProjectKeyReceipt,
) -> Result<(Zeroizing<String>, String), CommandError> {
    validate_stored_team_project_key_receipt(record)?;
    let json = Zeroizing::new(
        serde_json::to_vec(record).map_err(|_| team_project_key_receipt_corrupted())?,
    );
    if json.is_empty() || json.len() > MAX_STORED_TEAM_PROJECT_KEY_RECEIPT_BYTES {
        return Err(team_project_key_receipt_corrupted());
    }
    let fingerprint = sha256_hex(json.as_slice());
    let mut encoded = Zeroizing::new(String::with_capacity(
        STORED_TEAM_PROJECT_KEY_RECEIPT_PREFIX.len() + (json.len() * 4).div_ceil(3),
    ));
    encoded.push_str(STORED_TEAM_PROJECT_KEY_RECEIPT_PREFIX);
    URL_SAFE_NO_PAD.encode_string(json.as_slice(), &mut encoded);
    Ok((encoded, fingerprint))
}

fn decode_stored_team_project_key_receipt(
    value: &str,
) -> Result<StoredTeamProjectKeyReceipt, CommandError> {
    let encoded = value
        .strip_prefix(STORED_TEAM_PROJECT_KEY_RECEIPT_PREFIX)
        .ok_or_else(team_project_key_receipt_corrupted)?;
    if encoded.is_empty()
        || encoded.contains('=')
        || encoded.len() > (MAX_STORED_TEAM_PROJECT_KEY_RECEIPT_BYTES * 4).div_ceil(3)
    {
        return Err(team_project_key_receipt_corrupted());
    }
    let json = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| team_project_key_receipt_corrupted())?,
    );
    if json.is_empty()
        || json.len() > MAX_STORED_TEAM_PROJECT_KEY_RECEIPT_BYTES
        || URL_SAFE_NO_PAD.encode(json.as_slice()) != encoded
    {
        return Err(team_project_key_receipt_corrupted());
    }
    let record: StoredTeamProjectKeyReceipt = serde_json::from_slice(json.as_slice())
        .map_err(|_| team_project_key_receipt_corrupted())?;
    validate_stored_team_project_key_receipt(&record)?;
    Ok(record)
}

fn validate_stored_team_project_key_receipt(
    record: &StoredTeamProjectKeyReceipt,
) -> Result<(), CommandError> {
    if record.schema_version != 1 || record.receipt_kind != TEAM_PROJECT_KEY_RECEIPT_KIND {
        return Err(team_project_key_receipt_corrupted());
    }
    validate_uuid_v7(&record.account_id, "ACCOUNT_ID_INVALID")
        .map_err(|_| team_project_key_receipt_corrupted())?;
    validate_portable_revision(record.current_server_revision)
        .map_err(|_| team_project_key_receipt_corrupted())?;
    validate_project_security_timestamp(&record.current_key_updated_at)
        .map_err(|_| team_project_key_receipt_corrupted())?;
    validate_sha256_fingerprint(&record.project_key_fingerprint)
        .map_err(|_| team_project_key_receipt_corrupted())?;
    validate_team_project_key_envelope(&record.envelope, true)
        .map_err(|_| team_project_key_receipt_corrupted())?;
    let created_at = record
        .envelope
        .created_at()
        .ok_or_else(team_project_key_receipt_corrupted)?;
    validate_project_security_timestamp(created_at)
        .map_err(|_| team_project_key_receipt_corrupted())
}

fn team_project_key_receipt_storage_ref(record: &StoredTeamProjectKeyReceipt) -> String {
    let scope = format!(
        "inkshadow.team-project-key-receipt.v1|{}|{}|{}|{}|{}",
        record.envelope.team_id,
        record.envelope.project_id,
        record.envelope.key_version,
        record.account_id,
        record.envelope.recipient_device_id
    );
    format!(
        "{TEAM_PROJECT_KEY_RECEIPT_STORAGE_REF_PREFIX}{}",
        sha256_hex(scope.as_bytes())
    )
}

fn team_project_key_receipt_binding(
    record: &StoredTeamProjectKeyReceipt,
    native_storage_ref: String,
    native_receipt_fingerprint: String,
) -> Result<TeamProjectKeyReceiptBinding, CommandError> {
    let envelope_created_at = record
        .envelope
        .created_at()
        .ok_or_else(team_project_key_receipt_corrupted)?
        .to_owned();
    Ok(TeamProjectKeyReceiptBinding {
        schema_version: 1,
        receipt_kind: TEAM_PROJECT_KEY_RECEIPT_KIND.to_owned(),
        team_id: record.envelope.team_id.clone(),
        project_id: record.envelope.project_id.clone(),
        key_version: record.envelope.key_version,
        account_id: record.account_id.clone(),
        device_id: record.envelope.recipient_device_id.clone(),
        envelope_id: record.envelope.envelope_id.clone(),
        membership_id: record.envelope.membership_id.clone(),
        membership_revision: record.envelope.membership_revision,
        assignment_id: record.envelope.assignment_id.clone(),
        assignment_revision: record.envelope.assignment_revision,
        sender_device_id: record.envelope.sender_device_id.clone(),
        sender_public_key_fingerprint: record.envelope.sender_public_key_fingerprint.clone(),
        recipient_public_key_fingerprint: record.envelope.recipient_public_key_fingerprint.clone(),
        project_key_fingerprint: record.project_key_fingerprint.clone(),
        native_storage_ref,
        native_receipt_fingerprint,
        current_server_revision: record.current_server_revision,
        current_key_updated_at: record.current_key_updated_at.clone(),
        envelope_created_at,
    })
}

fn validate_stored_receipt_matches_binding(
    record: &StoredTeamProjectKeyReceipt,
    expected: &TeamProjectKeyReceiptBinding,
) -> Result<(), CommandError> {
    validate_stored_team_project_key_receipt(record)?;
    let (encoded, native_receipt_fingerprint) = encode_stored_team_project_key_receipt(record)?;
    let actual = team_project_key_receipt_binding(
        record,
        team_project_key_receipt_storage_ref(record),
        native_receipt_fingerprint,
    )?;
    let expected_json =
        serde_json::to_vec(expected).map_err(|_| team_project_key_receipt_binding_mismatch())?;
    let actual_json =
        serde_json::to_vec(&actual).map_err(|_| team_project_key_receipt_binding_mismatch())?;
    if actual_json != expected_json
        || !encoded
            .as_str()
            .starts_with(STORED_TEAM_PROJECT_KEY_RECEIPT_PREFIX)
    {
        return Err(team_project_key_receipt_binding_mismatch());
    }
    Ok(())
}

fn validate_team_project_key_receipt_binding(
    receipt: &TeamProjectKeyReceiptBinding,
) -> Result<(), CommandError> {
    if receipt.schema_version != 1 || receipt.receipt_kind != TEAM_PROJECT_KEY_RECEIPT_KIND {
        return Err(team_project_key_receipt_binding_mismatch());
    }
    validate_uuid_v7(&receipt.team_id, "TEAM_ID_INVALID")
        .map_err(|_| team_project_key_receipt_binding_mismatch())?;
    validate_uuid_v7(&receipt.project_id, "PROJECT_ID_INVALID")
        .map_err(|_| team_project_key_receipt_binding_mismatch())?;
    validate_key_version(receipt.key_version)
        .map_err(|_| team_project_key_receipt_binding_mismatch())?;
    validate_uuid_v7(&receipt.account_id, "ACCOUNT_ID_INVALID")
        .map_err(|_| team_project_key_receipt_binding_mismatch())?;
    validate_uuid_v7(&receipt.device_id, "DEVICE_ID_INVALID")
        .map_err(|_| team_project_key_receipt_binding_mismatch())?;
    for value in [
        &receipt.envelope_id,
        &receipt.membership_id,
        &receipt.assignment_id,
        &receipt.sender_device_id,
    ] {
        validate_uuid_v7(value, "TEAM_PROJECT_KEY_RECEIPT_INVALID")
            .map_err(|_| team_project_key_receipt_binding_mismatch())?;
    }
    for revision in [
        receipt.membership_revision,
        receipt.assignment_revision,
        receipt.current_server_revision,
    ] {
        validate_portable_revision(revision)
            .map_err(|_| team_project_key_receipt_binding_mismatch())?;
    }
    for fingerprint in [
        &receipt.sender_public_key_fingerprint,
        &receipt.recipient_public_key_fingerprint,
        &receipt.project_key_fingerprint,
        &receipt.native_receipt_fingerprint,
    ] {
        validate_sha256_fingerprint(fingerprint)
            .map_err(|_| team_project_key_receipt_binding_mismatch())?;
    }
    validate_project_security_timestamp(&receipt.current_key_updated_at)
        .map_err(|_| team_project_key_receipt_binding_mismatch())?;
    validate_project_security_timestamp(&receipt.envelope_created_at)
        .map_err(|_| team_project_key_receipt_binding_mismatch())?;
    validate_team_project_key_receipt_storage_ref(&receipt.native_storage_ref)?;
    let scope = format!(
        "inkshadow.team-project-key-receipt.v1|{}|{}|{}|{}|{}",
        receipt.team_id,
        receipt.project_id,
        receipt.key_version,
        receipt.account_id,
        receipt.device_id
    );
    let expected_ref = format!(
        "{TEAM_PROJECT_KEY_RECEIPT_STORAGE_REF_PREFIX}{}",
        sha256_hex(scope.as_bytes())
    );
    if receipt.native_storage_ref != expected_ref {
        return Err(team_project_key_receipt_binding_mismatch());
    }
    Ok(())
}

fn validate_team_project_key_receipt_storage_ref(value: &str) -> Result<(), CommandError> {
    let fingerprint = value
        .strip_prefix(TEAM_PROJECT_KEY_RECEIPT_STORAGE_REF_PREFIX)
        .ok_or_else(team_project_key_receipt_binding_mismatch)?;
    validate_sha256_fingerprint(fingerprint)
        .map_err(|_| team_project_key_receipt_binding_mismatch())
}

fn validate_sha256_fingerprint(value: &str) -> Result<(), CommandError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(encoded_value_invalid("PROJECT_KEY_FINGERPRINT_INVALID"))
    }
}

fn validate_project_security_timestamp(value: &str) -> Result<(), CommandError> {
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
        return Err(team_project_key_receipt_corrupted());
    }
    for index in [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22] {
        if !bytes[index].is_ascii_digit() {
            return Err(team_project_key_receipt_corrupted());
        }
    }
    let year = parse_project_security_digits(bytes, 0, 4);
    let month = parse_project_security_digits(bytes, 5, 2);
    let day = parse_project_security_digits(bytes, 8, 2);
    let hour = parse_project_security_digits(bytes, 11, 2);
    let minute = parse_project_security_digits(bytes, 14, 2);
    let second = parse_project_security_digits(bytes, 17, 2);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    };
    if year < 1970 || day == 0 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
        return Err(team_project_key_receipt_corrupted());
    }
    Ok(())
}

fn parse_project_security_digits(bytes: &[u8], start: usize, length: usize) -> u32 {
    bytes[start..start + length]
        .iter()
        .fold(0, |value, byte| value * 10 + u32::from(byte - b'0'))
}

pub(crate) fn load_device_identity_summary(
    device_id: &str,
) -> Result<DeviceIdentitySummary, CommandError> {
    let device_id = validate_uuid_v7(device_id, "DEVICE_ID_INVALID")?;
    let stored =
        device_identity_entry(&device_id)?
            .get_password()
            .map_err(|error| match error {
                keyring::Error::NoEntry => missing_device_identity(),
                _ => CommandError::credential_store_unavailable(),
            })?;
    let stored = Zeroizing::new(stored);
    let private_key = decode_stored_private_key(stored.as_str())?;
    Ok(identity_summary(&device_id, &private_key))
}

fn encode_stored_private_key(private_key: &DevicePrivateKey) -> String {
    format!(
        "{PRIVATE_KEY_FORMAT_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(private_key.to_bytes())
    )
}

fn decode_stored_private_key(value: &str) -> Result<DevicePrivateKey, CommandError> {
    let encoded = value
        .strip_prefix(PRIVATE_KEY_FORMAT_PREFIX)
        .ok_or_else(device_key_corrupted)?;
    let bytes = decode_base64url_exact(
        encoded,
        P256_PRIVATE_KEY_BYTES,
        "DEVICE_PRIVATE_KEY_CORRUPTED",
    )?;
    DevicePrivateKey::from_bytes(&bytes).map_err(|_| device_key_corrupted())
}

fn identity_summary(device_id: &str, private_key: &DevicePrivateKey) -> DeviceIdentitySummary {
    let public_key = DeviceKem::sk_to_pk(private_key);
    let public_key_bytes = public_key.to_bytes();
    DeviceIdentitySummary {
        schema_version: 1,
        device_id: device_id.to_owned(),
        algorithm: DEVICE_KEY_ALGORITHM,
        public_key: URL_SAFE_NO_PAD.encode(public_key_bytes),
        public_key_fingerprint: sha256_hex(public_key_bytes.as_ref()),
        private_key_storage: "os_credential_store",
    }
}

fn seal_device_envelope(
    input: WrapProjectDataKeyInput,
    sender_private_key: &DevicePrivateKey,
) -> Result<DeviceProjectKeyEnvelope, CommandError> {
    let WrapProjectDataKeyInput {
        envelope_id,
        project_id,
        key_version,
        sender_device_id,
        recipient_device_id,
        recipient_public_key,
        recipient_public_key_fingerprint,
        raw_project_data_key,
    } = input;
    let raw_project_data_key = Zeroizing::new(decode_base64url_exact(
        &raw_project_data_key,
        PROJECT_DATA_KEY_BYTES,
        "PROJECT_DATA_KEY_INVALID",
    )?);
    seal_device_envelope_with_key(
        DeviceEnvelopeTarget {
            envelope_id,
            project_id,
            key_version,
            sender_device_id,
            recipient_device_id,
            recipient_public_key,
            recipient_public_key_fingerprint,
        },
        sender_private_key,
        raw_project_data_key.as_slice(),
    )
}

fn seal_device_envelope_with_key(
    target: DeviceEnvelopeTarget,
    sender_private_key: &DevicePrivateKey,
    raw_project_data_key: &[u8],
) -> Result<DeviceProjectKeyEnvelope, CommandError> {
    let DeviceEnvelopeTarget {
        envelope_id,
        project_id,
        key_version,
        sender_device_id,
        recipient_device_id,
        recipient_public_key,
        recipient_public_key_fingerprint,
    } = target;
    let envelope_id = validate_uuid_v7(&envelope_id, "PROJECT_KEY_ENVELOPE_INVALID")?;
    let project_id = validate_uuid_v7(&project_id, "PROJECT_KEY_ENVELOPE_INVALID")?;
    let sender_device_id = validate_uuid_v7(&sender_device_id, "DEVICE_ID_INVALID")?;
    let recipient_device_id = validate_uuid_v7(&recipient_device_id, "DEVICE_ID_INVALID")?;
    validate_key_version(key_version)?;
    if raw_project_data_key.len() != PROJECT_DATA_KEY_BYTES {
        return Err(encoded_value_invalid("PROJECT_DATA_KEY_INVALID"));
    }

    let sender_public_key = DeviceKem::sk_to_pk(sender_private_key);
    let sender_public_key_bytes = sender_public_key.to_bytes();
    let sender_public_key_encoded = URL_SAFE_NO_PAD.encode(sender_public_key_bytes);
    let sender_public_key_fingerprint = sha256_hex(sender_public_key_bytes.as_ref());

    let recipient_public_key_bytes = decode_base64url_exact(
        &recipient_public_key,
        P256_PUBLIC_KEY_BYTES,
        "PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    let recipient_public_key_value =
        DevicePublicKey::from_bytes(&recipient_public_key_bytes).map_err(|_| envelope_invalid())?;
    let actual_recipient_fingerprint = sha256_hex(&recipient_public_key_bytes);
    if actual_recipient_fingerprint != recipient_public_key_fingerprint {
        return Err(envelope_invalid());
    }

    let aad = device_envelope_aad(
        &envelope_id,
        &project_id,
        key_version,
        &sender_device_id,
        &sender_public_key_fingerprint,
        &recipient_device_id,
        &actual_recipient_fingerprint,
    );
    let mut rng = StdRng::from_os_rng();
    let mode = OpModeS::Auth((sender_private_key.clone(), sender_public_key));
    let (encapsulated_key, mut context) =
        hpke::setup_sender::<DeviceAead, DeviceKdf, DeviceKem, _>(
            &mode,
            &recipient_public_key_value,
            HPKE_INFO,
            &mut rng,
        )
        .map_err(|_| envelope_crypto_failed())?;
    let ciphertext = context
        .seal(raw_project_data_key, aad.as_bytes())
        .map_err(|_| envelope_crypto_failed())?;
    if ciphertext.len() != HPKE_CIPHERTEXT_BYTES {
        return Err(envelope_crypto_failed());
    }

    Ok(DeviceProjectKeyEnvelope {
        schema_version: 1,
        algorithm: DEVICE_ENVELOPE_ALGORITHM.to_owned(),
        envelope_id,
        project_id,
        key_version,
        sender_device_id,
        sender_public_key: sender_public_key_encoded,
        sender_public_key_fingerprint,
        recipient_device_id,
        recipient_public_key,
        recipient_public_key_fingerprint: actual_recipient_fingerprint,
        encapsulated_key: URL_SAFE_NO_PAD.encode(encapsulated_key.to_bytes()),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
}

fn open_device_envelope(
    envelope: DeviceProjectKeyEnvelope,
    recipient_private_key: &DevicePrivateKey,
) -> Result<ProjectDataKeyMaterial, CommandError> {
    let plaintext = open_device_envelope_key_bytes(envelope, recipient_private_key)?;
    Ok(ProjectDataKeyMaterial {
        raw_project_data_key: URL_SAFE_NO_PAD.encode(plaintext.as_slice()),
        project_key_fingerprint: sha256_hex(plaintext.as_slice()),
    })
}

fn open_device_envelope_key_bytes(
    envelope: DeviceProjectKeyEnvelope,
    recipient_private_key: &DevicePrivateKey,
) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    validate_device_envelope(&envelope)?;
    let recipient_public_key = DeviceKem::sk_to_pk(recipient_private_key);
    let recipient_public_key_bytes = recipient_public_key.to_bytes();
    let recipient_public_key_encoded = URL_SAFE_NO_PAD.encode(recipient_public_key_bytes);
    let recipient_fingerprint = sha256_hex(recipient_public_key_bytes.as_ref());
    if recipient_public_key_encoded != envelope.recipient_public_key
        || recipient_fingerprint != envelope.recipient_public_key_fingerprint
    {
        return Err(envelope_recipient_mismatch());
    }

    let sender_public_key_bytes = decode_base64url_exact(
        &envelope.sender_public_key,
        P256_PUBLIC_KEY_BYTES,
        "PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    let sender_public_key =
        DevicePublicKey::from_bytes(&sender_public_key_bytes).map_err(|_| envelope_invalid())?;
    let encapsulated_key_bytes = decode_base64url_exact(
        &envelope.encapsulated_key,
        P256_PUBLIC_KEY_BYTES,
        "PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    let encapsulated_key =
        <DeviceKem as KemTrait>::EncappedKey::from_bytes(&encapsulated_key_bytes)
            .map_err(|_| envelope_invalid())?;
    let ciphertext = decode_base64url_exact(
        &envelope.ciphertext,
        HPKE_CIPHERTEXT_BYTES,
        "PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    let aad = device_envelope_aad(
        &envelope.envelope_id,
        &envelope.project_id,
        envelope.key_version,
        &envelope.sender_device_id,
        &envelope.sender_public_key_fingerprint,
        &envelope.recipient_device_id,
        &envelope.recipient_public_key_fingerprint,
    );
    let mode = OpModeR::Auth(sender_public_key);
    let mut context = hpke::setup_receiver::<DeviceAead, DeviceKdf, DeviceKem>(
        &mode,
        recipient_private_key,
        &encapsulated_key,
        HPKE_INFO,
    )
    .map_err(|_| envelope_open_failed())?;
    let plaintext = Zeroizing::new(
        context
            .open(&ciphertext, aad.as_bytes())
            .map_err(|_| envelope_open_failed())?,
    );
    if plaintext.len() != PROJECT_DATA_KEY_BYTES {
        return Err(envelope_open_failed());
    }
    Ok(plaintext)
}

fn rewrap_project_data_key_for_team_recipients_inner(
    input: RewrapProjectDataKeyForTeamRecipientsInput,
    sender_private_key: &DevicePrivateKey,
) -> Result<Vec<TeamProjectKeyEnvelope>, CommandError> {
    let RewrapProjectDataKeyForTeamRecipientsInput {
        team_id,
        project_id,
        key_version,
        sender_device_id,
        source_envelope,
        recipients,
    } = input;
    let team_id = validate_uuid_v7(&team_id, "TEAM_PROJECT_KEY_ENVELOPE_INVALID")?;
    let project_id = validate_uuid_v7(&project_id, "PROJECT_KEY_ENVELOPE_INVALID")?;
    let sender_device_id = validate_uuid_v7(&sender_device_id, "DEVICE_ID_INVALID")?;
    validate_key_version(key_version)?;
    if recipients.is_empty() || recipients.len() > MAX_TEAM_PROJECT_KEY_RECIPIENTS {
        return Err(team_recipient_set_invalid());
    }
    if source_envelope.project_id != project_id
        || source_envelope.key_version != key_version
        || source_envelope.recipient_device_id != sender_device_id
    {
        return Err(team_recipient_set_invalid());
    }

    let mut envelope_ids = HashSet::with_capacity(recipients.len());
    let mut recipient_device_ids = HashSet::with_capacity(recipients.len());
    let mut assignment_ids = HashSet::with_capacity(recipients.len());
    for recipient in &recipients {
        if !envelope_ids.insert(recipient.envelope_id.as_str())
            || !recipient_device_ids.insert(recipient.recipient_device_id.as_str())
            || !assignment_ids.insert(recipient.assignment_id.as_str())
        {
            return Err(team_recipient_set_invalid());
        }
        validate_uuid_v7(
            &recipient.membership_id,
            "TEAM_PROJECT_KEY_ENVELOPE_INVALID",
        )?;
        validate_uuid_v7(
            &recipient.assignment_id,
            "TEAM_PROJECT_KEY_ENVELOPE_INVALID",
        )?;
        validate_portable_revision(recipient.membership_revision)?;
        validate_portable_revision(recipient.assignment_revision)?;
    }

    let raw_project_data_key = open_device_envelope_key_bytes(source_envelope, sender_private_key)?;
    let mut envelopes = Vec::with_capacity(recipients.len());
    for recipient in recipients {
        envelopes.push(seal_team_project_key_envelope_with_key(
            &team_id,
            &project_id,
            key_version,
            &sender_device_id,
            recipient,
            sender_private_key,
            raw_project_data_key.as_slice(),
        )?);
    }
    Ok(envelopes)
}

fn seal_team_project_key_envelope_with_key(
    team_id: &str,
    project_id: &str,
    key_version: u32,
    sender_device_id: &str,
    recipient: TeamProjectKeyRecipientInput,
    sender_private_key: &DevicePrivateKey,
    raw_project_data_key: &[u8],
) -> Result<TeamProjectKeyEnvelope, CommandError> {
    let TeamProjectKeyRecipientInput {
        envelope_id,
        membership_id,
        membership_revision,
        assignment_id,
        assignment_revision,
        recipient_device_id,
        recipient_public_key,
        recipient_public_key_fingerprint,
    } = recipient;
    let envelope_id = validate_uuid_v7(&envelope_id, "TEAM_PROJECT_KEY_ENVELOPE_INVALID")?;
    let membership_id = validate_uuid_v7(&membership_id, "TEAM_PROJECT_KEY_ENVELOPE_INVALID")?;
    let assignment_id = validate_uuid_v7(&assignment_id, "TEAM_PROJECT_KEY_ENVELOPE_INVALID")?;
    let recipient_device_id = validate_uuid_v7(&recipient_device_id, "DEVICE_ID_INVALID")?;
    validate_portable_revision(membership_revision)?;
    validate_portable_revision(assignment_revision)?;
    if raw_project_data_key.len() != PROJECT_DATA_KEY_BYTES {
        return Err(encoded_value_invalid("PROJECT_DATA_KEY_INVALID"));
    }

    let sender_public_key = DeviceKem::sk_to_pk(sender_private_key);
    let sender_public_key_bytes = sender_public_key.to_bytes();
    let sender_public_key_encoded = URL_SAFE_NO_PAD.encode(sender_public_key_bytes);
    let sender_public_key_fingerprint = sha256_hex(sender_public_key_bytes.as_ref());
    let recipient_public_key_bytes = decode_base64url_exact(
        &recipient_public_key,
        P256_PUBLIC_KEY_BYTES,
        "TEAM_PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    let recipient_public_key_value = DevicePublicKey::from_bytes(&recipient_public_key_bytes)
        .map_err(|_| team_envelope_invalid())?;
    let actual_recipient_fingerprint = sha256_hex(&recipient_public_key_bytes);
    if actual_recipient_fingerprint != recipient_public_key_fingerprint {
        return Err(team_envelope_invalid());
    }

    let aad = team_project_key_envelope_aad(
        &envelope_id,
        team_id,
        project_id,
        key_version,
        &membership_id,
        membership_revision,
        &assignment_id,
        assignment_revision,
        sender_device_id,
        &sender_public_key_fingerprint,
        &recipient_device_id,
        &actual_recipient_fingerprint,
    );
    let mut rng = StdRng::from_os_rng();
    let mode = OpModeS::Auth((sender_private_key.clone(), sender_public_key));
    let (encapsulated_key, mut context) =
        hpke::setup_sender::<DeviceAead, DeviceKdf, DeviceKem, _>(
            &mode,
            &recipient_public_key_value,
            HPKE_INFO,
            &mut rng,
        )
        .map_err(|_| envelope_crypto_failed())?;
    let ciphertext = context
        .seal(raw_project_data_key, aad.as_bytes())
        .map_err(|_| envelope_crypto_failed())?;
    if ciphertext.len() != HPKE_CIPHERTEXT_BYTES {
        return Err(envelope_crypto_failed());
    }

    Ok(TeamProjectKeyEnvelope {
        schema_version: 1,
        envelope_kind: "team_project_member_device".to_owned(),
        envelope_id,
        team_id: team_id.to_owned(),
        project_id: project_id.to_owned(),
        key_version,
        membership_id,
        membership_revision,
        assignment_id,
        assignment_revision,
        algorithm: DEVICE_ENVELOPE_ALGORITHM.to_owned(),
        sender_device_id: sender_device_id.to_owned(),
        sender_public_key: sender_public_key_encoded,
        sender_public_key_fingerprint,
        recipient_device_id,
        recipient_public_key,
        recipient_public_key_fingerprint: actual_recipient_fingerprint,
        encapsulated_key: URL_SAFE_NO_PAD.encode(encapsulated_key.to_bytes()),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        created_at: None,
    })
}

fn verify_current_device_team_project_key_envelope_inner(
    envelope: &TeamProjectKeyEnvelope,
    recipient_private_key: &DevicePrivateKey,
    expected: &TeamProjectKeyEnvelopeExpectation<'_>,
) -> Result<TeamProjectKeyEnvelopeVerification, CommandError> {
    let plaintext = open_current_device_team_project_key_envelope_inner(
        envelope,
        recipient_private_key,
        expected,
    )?;
    let created_at = envelope
        .created_at
        .clone()
        .ok_or_else(team_envelope_invalid)?;
    Ok(TeamProjectKeyEnvelopeVerification {
        valid: true,
        envelope_id: envelope.envelope_id.clone(),
        team_id: envelope.team_id.clone(),
        project_id: envelope.project_id.clone(),
        key_version: envelope.key_version,
        current_key_server_revision: expected.current_key_server_revision,
        current_key_updated_at: expected.current_key_updated_at.to_owned(),
        membership_id: envelope.membership_id.clone(),
        membership_revision: envelope.membership_revision,
        assignment_id: envelope.assignment_id.clone(),
        assignment_revision: envelope.assignment_revision,
        sender_device_id: envelope.sender_device_id.clone(),
        sender_public_key_fingerprint: envelope.sender_public_key_fingerprint.clone(),
        recipient_device_id: envelope.recipient_device_id.clone(),
        recipient_public_key_fingerprint: envelope.recipient_public_key_fingerprint.clone(),
        project_key_fingerprint: sha256_hex(plaintext.as_slice()),
        created_at,
    })
}

fn open_current_device_team_project_key_envelope_inner(
    envelope: &TeamProjectKeyEnvelope,
    recipient_private_key: &DevicePrivateKey,
    expected: &TeamProjectKeyEnvelopeExpectation<'_>,
) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    validate_team_project_key_envelope(envelope, true)?;
    if envelope.team_id != expected.team_id
        || envelope.project_id != expected.project_id
        || envelope.key_version != expected.key_version
        || envelope.recipient_device_id != expected.recipient_device_id
        || envelope.recipient_public_key != expected.recipient_public_key
        || envelope.recipient_public_key_fingerprint != expected.recipient_public_key_fingerprint
    {
        return Err(team_envelope_scope_mismatch());
    }

    let recipient_public_key = DeviceKem::sk_to_pk(recipient_private_key);
    let recipient_public_key_bytes = recipient_public_key.to_bytes();
    if URL_SAFE_NO_PAD.encode(recipient_public_key_bytes) != envelope.recipient_public_key
        || sha256_hex(recipient_public_key_bytes.as_ref())
            != envelope.recipient_public_key_fingerprint
    {
        return Err(envelope_recipient_mismatch());
    }
    let sender_public_key_bytes = decode_base64url_exact(
        &envelope.sender_public_key,
        P256_PUBLIC_KEY_BYTES,
        "TEAM_PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    let sender_public_key = DevicePublicKey::from_bytes(&sender_public_key_bytes)
        .map_err(|_| team_envelope_invalid())?;
    let encapsulated_key_bytes = decode_base64url_exact(
        &envelope.encapsulated_key,
        P256_PUBLIC_KEY_BYTES,
        "TEAM_PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    let encapsulated_key =
        <DeviceKem as KemTrait>::EncappedKey::from_bytes(&encapsulated_key_bytes)
            .map_err(|_| team_envelope_invalid())?;
    let ciphertext = decode_base64url_exact(
        &envelope.ciphertext,
        HPKE_CIPHERTEXT_BYTES,
        "TEAM_PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    let aad = team_project_key_envelope_aad(
        &envelope.envelope_id,
        &envelope.team_id,
        &envelope.project_id,
        envelope.key_version,
        &envelope.membership_id,
        envelope.membership_revision,
        &envelope.assignment_id,
        envelope.assignment_revision,
        &envelope.sender_device_id,
        &envelope.sender_public_key_fingerprint,
        &envelope.recipient_device_id,
        &envelope.recipient_public_key_fingerprint,
    );
    let mode = OpModeR::Auth(sender_public_key);
    let mut context = hpke::setup_receiver::<DeviceAead, DeviceKdf, DeviceKem>(
        &mode,
        recipient_private_key,
        &encapsulated_key,
        HPKE_INFO,
    )
    .map_err(|_| envelope_open_failed())?;
    let plaintext = Zeroizing::new(
        context
            .open(&ciphertext, aad.as_bytes())
            .map_err(|_| envelope_open_failed())?,
    );
    if plaintext.len() != PROJECT_DATA_KEY_BYTES {
        return Err(envelope_open_failed());
    }
    Ok(plaintext)
}

fn validate_team_project_key_envelope(
    envelope: &TeamProjectKeyEnvelope,
    require_created_at: bool,
) -> Result<(), CommandError> {
    if envelope.schema_version != 1
        || envelope.envelope_kind != "team_project_member_device"
        || envelope.algorithm != DEVICE_ENVELOPE_ALGORITHM
        || require_created_at != envelope.created_at.is_some()
    {
        return Err(team_envelope_invalid());
    }
    validate_uuid_v7(&envelope.envelope_id, "TEAM_PROJECT_KEY_ENVELOPE_INVALID")?;
    validate_uuid_v7(&envelope.team_id, "TEAM_PROJECT_KEY_ENVELOPE_INVALID")?;
    validate_uuid_v7(&envelope.project_id, "TEAM_PROJECT_KEY_ENVELOPE_INVALID")?;
    validate_key_version(envelope.key_version)?;
    validate_uuid_v7(&envelope.membership_id, "TEAM_PROJECT_KEY_ENVELOPE_INVALID")?;
    validate_portable_revision(envelope.membership_revision)?;
    validate_uuid_v7(&envelope.assignment_id, "TEAM_PROJECT_KEY_ENVELOPE_INVALID")?;
    validate_portable_revision(envelope.assignment_revision)?;
    validate_uuid_v7(&envelope.sender_device_id, "DEVICE_ID_INVALID")?;
    validate_uuid_v7(&envelope.recipient_device_id, "DEVICE_ID_INVALID")?;
    let sender_public_key = decode_base64url_exact(
        &envelope.sender_public_key,
        P256_PUBLIC_KEY_BYTES,
        "TEAM_PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    let recipient_public_key = decode_base64url_exact(
        &envelope.recipient_public_key,
        P256_PUBLIC_KEY_BYTES,
        "TEAM_PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    if sha256_hex(&sender_public_key) != envelope.sender_public_key_fingerprint
        || sha256_hex(&recipient_public_key) != envelope.recipient_public_key_fingerprint
    {
        return Err(team_envelope_invalid());
    }
    decode_base64url_exact(
        &envelope.encapsulated_key,
        P256_PUBLIC_KEY_BYTES,
        "TEAM_PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    decode_base64url_exact(
        &envelope.ciphertext,
        HPKE_CIPHERTEXT_BYTES,
        "TEAM_PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    Ok(())
}

fn validate_portable_revision(value: u64) -> Result<(), CommandError> {
    if value == 0 || value > MAX_PORTABLE_INTEGER {
        Err(team_envelope_invalid())
    } else {
        Ok(())
    }
}

fn validate_device_envelope(envelope: &DeviceProjectKeyEnvelope) -> Result<(), CommandError> {
    if envelope.schema_version != 1 || envelope.algorithm != DEVICE_ENVELOPE_ALGORITHM {
        return Err(envelope_invalid());
    }
    validate_uuid_v7(&envelope.envelope_id, "PROJECT_KEY_ENVELOPE_INVALID")?;
    validate_uuid_v7(&envelope.project_id, "PROJECT_KEY_ENVELOPE_INVALID")?;
    validate_uuid_v7(&envelope.sender_device_id, "DEVICE_ID_INVALID")?;
    validate_uuid_v7(&envelope.recipient_device_id, "DEVICE_ID_INVALID")?;
    validate_key_version(envelope.key_version)?;

    let sender_public_key = decode_base64url_exact(
        &envelope.sender_public_key,
        P256_PUBLIC_KEY_BYTES,
        "PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    let recipient_public_key = decode_base64url_exact(
        &envelope.recipient_public_key,
        P256_PUBLIC_KEY_BYTES,
        "PROJECT_KEY_ENVELOPE_INVALID",
    )?;
    if sha256_hex(&sender_public_key) != envelope.sender_public_key_fingerprint
        || sha256_hex(&recipient_public_key) != envelope.recipient_public_key_fingerprint
    {
        return Err(envelope_invalid());
    }
    Ok(())
}

fn device_envelope_aad(
    envelope_id: &str,
    project_id: &str,
    key_version: u32,
    sender_device_id: &str,
    sender_fingerprint: &str,
    recipient_device_id: &str,
    recipient_fingerprint: &str,
) -> String {
    format!(
        "{DEVICE_ENVELOPE_ALGORITHM}|{envelope_id}|{project_id}|{key_version}|\
         {sender_device_id}|{sender_fingerprint}|{recipient_device_id}|{recipient_fingerprint}"
    )
}

#[allow(clippy::too_many_arguments)]
fn team_project_key_envelope_aad(
    envelope_id: &str,
    team_id: &str,
    project_id: &str,
    key_version: u32,
    membership_id: &str,
    membership_revision: u64,
    assignment_id: &str,
    assignment_revision: u64,
    sender_device_id: &str,
    sender_fingerprint: &str,
    recipient_device_id: &str,
    recipient_fingerprint: &str,
) -> String {
    format!(
        "team_project_member_device|{DEVICE_ENVELOPE_ALGORITHM}|{envelope_id}|{team_id}|\
         {project_id}|{key_version}|{membership_id}|{membership_revision}|{assignment_id}|\
         {assignment_revision}|{sender_device_id}|{sender_fingerprint}|{recipient_device_id}|\
         {recipient_fingerprint}"
    )
}

fn create_recovery_kit_inner(input: CreateRecoveryKitInput) -> Result<RecoveryKit, CommandError> {
    let CreateRecoveryKitInput {
        recovery_id,
        project_id,
        key_version,
        raw_project_data_key,
    } = input;
    let recovery_id = validate_uuid_v7(&recovery_id, "RECOVERY_ENVELOPE_INVALID")?;
    let project_id = validate_uuid_v7(&project_id, "RECOVERY_ENVELOPE_INVALID")?;
    validate_key_version(key_version)?;
    let raw_project_data_key = Zeroizing::new(decode_base64url_exact(
        &raw_project_data_key,
        PROJECT_DATA_KEY_BYTES,
        "PROJECT_DATA_KEY_INVALID",
    )?);

    let mut rng = StdRng::from_os_rng();
    let mut recovery_secret = Zeroizing::new([0_u8; RECOVERY_SECRET_BYTES]);
    let mut salt = [0_u8; RECOVERY_SALT_BYTES];
    let mut nonce = [0_u8; RECOVERY_NONCE_BYTES];
    rng.fill_bytes(recovery_secret.as_mut());
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce);
    let recovery_code = Zeroizing::new(format!(
        "{RECOVERY_CODE_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(*recovery_secret)
    ));

    let derived = derive_recovery_material(recovery_code.as_bytes(), &salt)?;
    let aad = recovery_envelope_aad(&recovery_id, &project_id, key_version);
    let cipher = Aes256Gcm::new_from_slice(&derived[..32]).map_err(|_| recovery_crypto_failed())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: raw_project_data_key.as_slice(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| recovery_crypto_failed())?;
    let verifier = recovery_verifier(&derived[32..], aad.as_bytes())?;

    Ok(RecoveryKit {
        recovery_code: recovery_code.to_string(),
        envelope: RecoveryProjectKeyEnvelope {
            schema_version: 1,
            algorithm: RECOVERY_ENVELOPE_ALGORITHM.to_owned(),
            recovery_id,
            project_id,
            key_version,
            kdf: production_recovery_kdf_parameters(),
            salt: URL_SAFE_NO_PAD.encode(salt),
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
            verifier: URL_SAFE_NO_PAD.encode(verifier),
        },
    })
}

fn recover_project_data_key_inner(
    input: VerifyRecoveryKitInput,
) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    validate_recovery_envelope(&input.envelope)?;
    let recovery_code = Zeroizing::new(input.recovery_code);
    validate_recovery_code(recovery_code.as_str())?;
    let salt = decode_base64url_exact(
        &input.envelope.salt,
        RECOVERY_SALT_BYTES,
        "RECOVERY_ENVELOPE_INVALID",
    )?;
    let nonce = decode_base64url_exact(
        &input.envelope.nonce,
        RECOVERY_NONCE_BYTES,
        "RECOVERY_ENVELOPE_INVALID",
    )?;
    let ciphertext = decode_base64url_exact(
        &input.envelope.ciphertext,
        HPKE_CIPHERTEXT_BYTES,
        "RECOVERY_ENVELOPE_INVALID",
    )?;
    let verifier =
        decode_base64url_exact(&input.envelope.verifier, 32, "RECOVERY_ENVELOPE_INVALID")?;
    let derived = derive_recovery_material(recovery_code.as_bytes(), &salt)?;
    let aad = recovery_envelope_aad(
        &input.envelope.recovery_id,
        &input.envelope.project_id,
        input.envelope.key_version,
    );
    verify_recovery_verifier(&derived[32..], aad.as_bytes(), &verifier)?;

    let cipher = Aes256Gcm::new_from_slice(&derived[..32]).map_err(|_| recovery_code_invalid())?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| recovery_code_invalid())?,
    );
    if plaintext.len() != PROJECT_DATA_KEY_BYTES {
        return Err(recovery_code_invalid());
    }
    Ok(plaintext)
}

fn validate_recovery_envelope(envelope: &RecoveryProjectKeyEnvelope) -> Result<(), CommandError> {
    if envelope.schema_version != 1
        || envelope.algorithm != RECOVERY_ENVELOPE_ALGORITHM
        || envelope.kdf != production_recovery_kdf_parameters()
    {
        return Err(recovery_envelope_invalid());
    }
    validate_uuid_v7(&envelope.recovery_id, "RECOVERY_ENVELOPE_INVALID")?;
    validate_uuid_v7(&envelope.project_id, "RECOVERY_ENVELOPE_INVALID")?;
    validate_key_version(envelope.key_version)
}

fn production_recovery_kdf_parameters() -> RecoveryKdfParameters {
    RecoveryKdfParameters {
        algorithm: "ARGON2ID".to_owned(),
        version: 19,
        memory_kib: RECOVERY_MEMORY_KIB,
        time_cost: RECOVERY_TIME_COST,
        parallelism: RECOVERY_PARALLELISM,
        output_bytes: RECOVERY_DERIVED_BYTES as u32,
    }
}

fn derive_recovery_material(
    recovery_code: &[u8],
    salt: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    let params = Params::new(
        RECOVERY_MEMORY_KIB,
        RECOVERY_TIME_COST,
        RECOVERY_PARALLELISM,
        Some(RECOVERY_DERIVED_BYTES),
    )
    .map_err(|_| recovery_crypto_failed())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = Zeroizing::new(vec![0_u8; RECOVERY_DERIVED_BYTES]);
    argon2
        .hash_password_into(recovery_code, salt, output.as_mut_slice())
        .map_err(|_| recovery_crypto_failed())?;
    Ok(output)
}

fn recovery_verifier(key: &[u8], aad: &[u8]) -> Result<Vec<u8>, CommandError> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).map_err(|_| recovery_crypto_failed())?;
    mac.update(b"inkshadow.recovery.verifier.v1|");
    mac.update(aad);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn verify_recovery_verifier(key: &[u8], aad: &[u8], expected: &[u8]) -> Result<(), CommandError> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).map_err(|_| recovery_code_invalid())?;
    mac.update(b"inkshadow.recovery.verifier.v1|");
    mac.update(aad);
    mac.verify_slice(expected)
        .map_err(|_| recovery_code_invalid())
}

fn recovery_envelope_aad(recovery_id: &str, project_id: &str, key_version: u32) -> String {
    format!("{RECOVERY_ENVELOPE_ALGORITHM}|{recovery_id}|{project_id}|{key_version}")
}

fn validate_recovery_code(value: &str) -> Result<(), CommandError> {
    let encoded = value
        .strip_prefix(RECOVERY_CODE_PREFIX)
        .ok_or_else(recovery_code_invalid)?;
    decode_base64url_exact(encoded, RECOVERY_SECRET_BYTES, "RECOVERY_CODE_INVALID")?;
    Ok(())
}

fn validate_key_version(value: u32) -> Result<(), CommandError> {
    if value == 0 || value > i32::MAX as u32 {
        Err(CommandError::new(
            "PROJECT_KEY_VERSION_INVALID",
            "The project key version is invalid.",
            false,
            vec!["RELOAD_PROJECT_SECURITY"],
        ))
    } else {
        Ok(())
    }
}

fn validate_uuid_v7(value: &str, code: &'static str) -> Result<String, CommandError> {
    let parsed = Uuid::parse_str(value).map_err(|_| {
        CommandError::new(
            code,
            "A project security identifier is invalid.",
            false,
            vec!["RELOAD_PROJECT_SECURITY"],
        )
    })?;
    if parsed.get_version() != Some(UuidVersion::SortRand) || parsed.to_string() != value {
        return Err(CommandError::new(
            code,
            "A project security identifier is invalid.",
            false,
            vec!["RELOAD_PROJECT_SECURITY"],
        ));
    }
    Ok(value.to_owned())
}

fn decode_base64url_exact(
    value: &str,
    expected_bytes: usize,
    code: &'static str,
) -> Result<Vec<u8>, CommandError> {
    if value.is_empty() || value.len() > 16_384 || value.contains('=') {
        return Err(encoded_value_invalid(code));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| encoded_value_invalid(code))?;
    if decoded.len() != expected_bytes || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(encoded_value_invalid(code));
    }
    Ok(decoded)
}

fn sha256_hex(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn encoded_value_invalid(code: &'static str) -> CommandError {
    CommandError::new(
        code,
        "Encoded project security material is invalid.",
        false,
        vec!["RELOAD_PROJECT_SECURITY"],
    )
}

fn missing_device_identity() -> CommandError {
    CommandError::new(
        "DEVICE_IDENTITY_MISSING",
        "This device does not have the required private identity key.",
        false,
        vec!["AUTHORIZE_DEVICE", "USE_RECOVERY_CODE"],
    )
}

fn device_key_corrupted() -> CommandError {
    CommandError::new(
        "DEVICE_PRIVATE_KEY_CORRUPTED",
        "The stored device identity key cannot be opened.",
        false,
        vec!["USE_RECOVERY_CODE", "OPEN_DIAGNOSTICS"],
    )
}

fn envelope_invalid() -> CommandError {
    CommandError::new(
        "PROJECT_KEY_ENVELOPE_INVALID",
        "The project key envelope is invalid.",
        false,
        vec!["REFRESH_KEY_ENVELOPES", "OPEN_DIAGNOSTICS"],
    )
}

fn envelope_crypto_failed() -> CommandError {
    CommandError::new(
        "PROJECT_KEY_WRAP_FAILED",
        "The project data key could not be wrapped for the target device.",
        false,
        vec!["RETRY", "REFRESH_DEVICE_KEYS"],
    )
}

fn envelope_open_failed() -> CommandError {
    CommandError::new(
        "PROJECT_KEY_OPEN_FAILED",
        "The project data key envelope could not be authenticated.",
        false,
        vec!["REFRESH_KEY_ENVELOPES", "USE_RECOVERY_CODE"],
    )
}

fn envelope_recipient_mismatch() -> CommandError {
    CommandError::new(
        "PROJECT_KEY_RECIPIENT_MISMATCH",
        "The project key envelope does not belong to this device identity.",
        false,
        vec!["AUTHORIZE_DEVICE", "USE_RECOVERY_CODE"],
    )
}

fn team_recipient_set_invalid() -> CommandError {
    CommandError::new(
        "TEAM_PROJECT_KEY_RECIPIENT_SET_INVALID",
        "The team project-key recipient snapshot is invalid.",
        false,
        vec!["REFRESH_TEAM_KEY_RECIPIENTS", "OPEN_DIAGNOSTICS"],
    )
}

fn team_envelope_invalid() -> CommandError {
    CommandError::new(
        "TEAM_PROJECT_KEY_ENVELOPE_INVALID",
        "The team project-key envelope is invalid.",
        false,
        vec!["REFRESH_TEAM_KEY_ENVELOPE", "OPEN_DIAGNOSTICS"],
    )
}

fn team_envelope_scope_mismatch() -> CommandError {
    CommandError::new(
        "TEAM_PROJECT_KEY_ENVELOPE_SCOPE_MISMATCH",
        "The team project-key envelope does not match the authenticated request scope.",
        false,
        vec!["REFRESH_TEAM_KEY_ENVELOPE", "REAUTHENTICATE"],
    )
}

fn team_project_key_receipt_missing() -> CommandError {
    CommandError::new(
        "TEAM_PROJECT_KEY_RECEIPT_MISSING",
        "The accepted team project key is not present in the operating system credential store.",
        false,
        vec!["REDOWNLOAD_TEAM_KEY_ENVELOPE", "OPEN_DIAGNOSTICS"],
    )
}

fn team_project_key_receipt_corrupted() -> CommandError {
    CommandError::new(
        "TEAM_PROJECT_KEY_RECEIPT_CORRUPTED",
        "The stored team project-key receipt is invalid.",
        false,
        vec!["REDOWNLOAD_TEAM_KEY_ENVELOPE", "OPEN_DIAGNOSTICS"],
    )
}

fn team_project_key_receipt_binding_mismatch() -> CommandError {
    CommandError::new(
        "TEAM_PROJECT_KEY_RECEIPT_BINDING_MISMATCH",
        "The stored team project-key receipt does not match the requested authority scope.",
        false,
        vec!["RELOAD_PROJECT_SECURITY", "REAUTHENTICATE"],
    )
}

fn team_project_key_receipt_rollback_blocked() -> CommandError {
    CommandError::new(
        "TEAM_PROJECT_KEY_RECEIPT_ROLLBACK_BLOCKED",
        "An older team project-key receipt cannot replace newer local authority metadata.",
        false,
        vec!["REFRESH_TEAM_KEY_ENVELOPE", "OPEN_DIAGNOSTICS"],
    )
}

fn team_project_key_receipt_conflict() -> CommandError {
    CommandError::new(
        "TEAM_PROJECT_KEY_RECEIPT_CONFLICT",
        "The team project-key receipt changed without a newer authority revision.",
        true,
        vec!["RETRY", "REFRESH_TEAM_KEY_ENVELOPE", "OPEN_DIAGNOSTICS"],
    )
}

fn recovery_envelope_invalid() -> CommandError {
    CommandError::new(
        "RECOVERY_ENVELOPE_INVALID",
        "The project recovery envelope is invalid or uses unsupported parameters.",
        false,
        vec!["REFRESH_RECOVERY_ENVELOPE", "OPEN_DIAGNOSTICS"],
    )
}

fn recovery_code_invalid() -> CommandError {
    CommandError::new(
        "RECOVERY_CODE_INVALID",
        "The recovery code is invalid for this project key.",
        false,
        vec!["RETRY_RECOVERY", "AUTHORIZE_DEVICE"],
    )
}

fn recovery_crypto_failed() -> CommandError {
    CommandError::new(
        "RECOVERY_CRYPTO_FAILED",
        "The project recovery envelope could not be created.",
        false,
        vec!["RETRY", "OPEN_DIAGNOSTICS"],
    )
}

fn crypto_runtime_failed() -> CommandError {
    CommandError::new(
        "PROJECT_KEY_CRYPTO_RUNTIME_FAILED",
        "The project key operation could not complete.",
        true,
        vec!["RETRY", "OPEN_DIAGNOSTICS"],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000001";
    const SENDER_DEVICE_ID: &str = "019f9f4a-b3c7-7350-9226-000000000002";
    const RECIPIENT_DEVICE_ID: &str = "019f9f4a-b3c7-7350-9226-000000000003";
    const ENVELOPE_ID: &str = "019f9f4a-b3c7-7350-9226-000000000004";
    const RECOVERY_ID: &str = "019f9f4a-b3c7-7350-9226-000000000005";
    const SOURCE_SENDER_DEVICE_ID: &str = "019f9f4a-b3c7-7350-9226-000000000006";
    const SOURCE_ENVELOPE_ID: &str = "019f9f4a-b3c7-7350-9226-000000000007";
    const TEAM_ID: &str = "019f9f4a-b3c7-7350-9226-000000000008";
    const MEMBERSHIP_ID: &str = "019f9f4a-b3c7-7350-9226-000000000009";
    const ASSIGNMENT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000010";
    const SECOND_ASSIGNMENT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000011";
    const ACCOUNT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000012";

    #[test]
    fn authenticated_hpke_envelope_round_trips_and_binds_metadata() {
        let mut rng = StdRng::from_seed([7_u8; 32]);
        let (sender_private, _) = DeviceKem::gen_keypair(&mut rng);
        let (recipient_private, recipient_public) = DeviceKem::gen_keypair(&mut rng);
        let recipient_public_bytes = recipient_public.to_bytes();
        let raw_key = [9_u8; PROJECT_DATA_KEY_BYTES];
        let envelope = seal_device_envelope(
            WrapProjectDataKeyInput {
                envelope_id: ENVELOPE_ID.to_owned(),
                project_id: PROJECT_ID.to_owned(),
                key_version: 1,
                sender_device_id: SENDER_DEVICE_ID.to_owned(),
                recipient_device_id: RECIPIENT_DEVICE_ID.to_owned(),
                recipient_public_key: URL_SAFE_NO_PAD.encode(recipient_public_bytes),
                recipient_public_key_fingerprint: sha256_hex(recipient_public_bytes.as_ref()),
                raw_project_data_key: URL_SAFE_NO_PAD.encode(raw_key),
            },
            &sender_private,
        )
        .expect("envelope should seal");

        let opened =
            open_device_envelope(envelope.clone(), &recipient_private).expect("should open");
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(opened.raw_project_data_key)
                .expect("valid base64url"),
            raw_key
        );

        let mut tampered = envelope;
        tampered.key_version = 2;
        let error = match open_device_envelope(tampered, &recipient_private) {
            Ok(_) => panic!("AAD tampering must fail"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "PROJECT_KEY_OPEN_FAILED");
    }

    #[test]
    fn stored_private_key_round_trips_without_appearing_in_summary() {
        let mut rng = StdRng::from_seed([11_u8; 32]);
        let (private_key, _) = DeviceKem::gen_keypair(&mut rng);
        let encoded = Zeroizing::new(encode_stored_private_key(&private_key));
        let decoded = decode_stored_private_key(encoded.as_str()).expect("stored key should parse");
        assert_eq!(private_key.to_bytes(), decoded.to_bytes());

        let summary = identity_summary(SENDER_DEVICE_ID, &private_key);
        let json = serde_json::to_string(&summary).expect("summary should serialize");
        assert!(!json.contains(PRIVATE_KEY_FORMAT_PREFIX));
        assert!(!json.contains(&URL_SAFE_NO_PAD.encode(private_key.to_bytes())));
    }

    #[test]
    fn team_recipient_rewrap_keeps_plaintext_inside_the_native_crypto_boundary() {
        let mut rng = StdRng::from_seed([19_u8; 32]);
        let (source_sender_private, _) = DeviceKem::gen_keypair(&mut rng);
        let (current_device_private, current_device_public) = DeviceKem::gen_keypair(&mut rng);
        let (team_recipient_private, team_recipient_public) = DeviceKem::gen_keypair(&mut rng);
        let current_device_public_bytes = current_device_public.to_bytes();
        let team_recipient_public_bytes = team_recipient_public.to_bytes();
        let raw_key = [23_u8; PROJECT_DATA_KEY_BYTES];
        let source_envelope = seal_device_envelope(
            WrapProjectDataKeyInput {
                envelope_id: SOURCE_ENVELOPE_ID.to_owned(),
                project_id: PROJECT_ID.to_owned(),
                key_version: 3,
                sender_device_id: SOURCE_SENDER_DEVICE_ID.to_owned(),
                recipient_device_id: SENDER_DEVICE_ID.to_owned(),
                recipient_public_key: URL_SAFE_NO_PAD.encode(current_device_public_bytes),
                recipient_public_key_fingerprint: sha256_hex(current_device_public_bytes.as_ref()),
                raw_project_data_key: URL_SAFE_NO_PAD.encode(raw_key),
            },
            &source_sender_private,
        )
        .expect("source envelope should seal");

        let envelopes = rewrap_project_data_key_for_team_recipients_inner(
            RewrapProjectDataKeyForTeamRecipientsInput {
                team_id: TEAM_ID.to_owned(),
                project_id: PROJECT_ID.to_owned(),
                key_version: 3,
                sender_device_id: SENDER_DEVICE_ID.to_owned(),
                source_envelope,
                recipients: vec![TeamProjectKeyRecipientInput {
                    envelope_id: ENVELOPE_ID.to_owned(),
                    membership_id: MEMBERSHIP_ID.to_owned(),
                    membership_revision: 7,
                    assignment_id: ASSIGNMENT_ID.to_owned(),
                    assignment_revision: 11,
                    recipient_device_id: RECIPIENT_DEVICE_ID.to_owned(),
                    recipient_public_key: URL_SAFE_NO_PAD.encode(team_recipient_public_bytes),
                    recipient_public_key_fingerprint: sha256_hex(
                        team_recipient_public_bytes.as_ref(),
                    ),
                }],
            },
            &current_device_private,
        )
        .expect("team recipient should be rewrapped");

        assert_eq!(envelopes.len(), 1);
        let mut envelope = envelopes.into_iter().next().expect("one envelope");
        assert_eq!(envelope.sender_device_id, SENDER_DEVICE_ID);
        assert_eq!(
            envelope.sender_public_key,
            URL_SAFE_NO_PAD.encode(current_device_public_bytes)
        );
        envelope.created_at = Some("2026-07-28T02:00:00.000Z".to_owned());
        let mut tampered = envelope.clone();
        tampered.assignment_revision += 1;
        let recipient_public_key = URL_SAFE_NO_PAD.encode(team_recipient_public_bytes);
        let recipient_fingerprint = sha256_hex(team_recipient_public_bytes.as_ref());
        let verified = verify_current_device_team_project_key_envelope_inner(
            &envelope,
            &team_recipient_private,
            &TeamProjectKeyEnvelopeExpectation {
                account_id: ACCOUNT_ID,
                team_id: TEAM_ID,
                project_id: PROJECT_ID,
                key_version: 3,
                current_key_server_revision: 13,
                current_key_updated_at: "2026-07-28T01:59:00.000Z",
                recipient_device_id: RECIPIENT_DEVICE_ID,
                recipient_public_key: &recipient_public_key,
                recipient_public_key_fingerprint: &recipient_fingerprint,
            },
        )
        .expect("recipient should authenticate and fingerprint the rewrapped key");
        assert_eq!(verified.project_key_fingerprint, sha256_hex(&raw_key));
        assert_eq!(verified.current_key_server_revision, 13);
        assert_eq!(verified.current_key_updated_at, "2026-07-28T01:59:00.000Z");
        let serialized = serde_json::to_string(&verified).expect("verification should serialize");
        assert!(!serialized.contains("ciphertext"));
        assert!(!serialized.contains("encapsulatedKey"));
        assert!(!serialized.contains("privateKey"));
        assert!(!serialized.contains(&URL_SAFE_NO_PAD.encode(raw_key)));

        let error = verify_current_device_team_project_key_envelope_inner(
            &tampered,
            &team_recipient_private,
            &TeamProjectKeyEnvelopeExpectation {
                account_id: ACCOUNT_ID,
                team_id: TEAM_ID,
                project_id: PROJECT_ID,
                key_version: 3,
                current_key_server_revision: 13,
                current_key_updated_at: "2026-07-28T01:59:00.000Z",
                recipient_device_id: RECIPIENT_DEVICE_ID,
                recipient_public_key: &recipient_public_key,
                recipient_public_key_fingerprint: &recipient_fingerprint,
            },
        )
        .expect_err("team assignment metadata is authenticated as HPKE AAD");
        assert_eq!(error.code(), "PROJECT_KEY_OPEN_FAILED");
    }

    #[test]
    fn team_receipt_encoding_is_canonical_bounded_and_command_metadata_is_non_secret() {
        let record = stored_team_receipt(9, "2026-07-28T01:59:00.000Z");
        let (encoded, fingerprint) =
            encode_stored_team_project_key_receipt(&record).expect("receipt encodes");
        assert!(encoded.starts_with(STORED_TEAM_PROJECT_KEY_RECEIPT_PREFIX));
        assert!(encoded.len() < MAX_STORED_TEAM_PROJECT_KEY_RECEIPT_BYTES * 2);
        let decoded =
            decode_stored_team_project_key_receipt(encoded.as_str()).expect("receipt decodes");
        let (canonical, decoded_fingerprint) =
            encode_stored_team_project_key_receipt(&decoded).expect("receipt re-encodes");
        assert_eq!(canonical.as_str(), encoded.as_str());
        assert_eq!(decoded_fingerprint, fingerprint);
        let storage_ref = team_project_key_receipt_storage_ref(&decoded);
        assert_eq!(
            storage_ref.len(),
            TEAM_PROJECT_KEY_RECEIPT_STORAGE_REF_PREFIX.len() + 64
        );
        let binding =
            team_project_key_receipt_binding(&decoded, storage_ref, fingerprint).expect("binding");
        let wire = serde_json::to_string(&binding).expect("binding serializes");
        for forbidden in [
            "ciphertext",
            "encapsulatedKey",
            "rawProjectDataKey",
            "privateKey",
            "recoveryCode",
        ] {
            assert!(!wire.contains(forbidden));
        }
    }

    #[test]
    fn team_receipt_write_classification_is_idempotent_and_monotonic() {
        let current = stored_team_receipt(9, "2026-07-28T01:59:00.000Z");
        assert!(matches!(
            classify_team_project_key_receipt_write(&current, &current, true).expect("exact retry"),
            TeamProjectKeyReceiptWriteState::AlreadyPresent
        ));

        let older_revision = stored_team_receipt(8, "2026-07-28T01:58:00.000Z");
        assert_eq!(
            classify_team_project_key_receipt_write(&current, &older_revision, false)
                .expect_err("revision rollback")
                .code(),
            "TEAM_PROJECT_KEY_RECEIPT_ROLLBACK_BLOCKED"
        );

        let same_revision_conflict = stored_team_receipt(9, "2026-07-28T02:00:00.000Z");
        assert_eq!(
            classify_team_project_key_receipt_write(&current, &same_revision_conflict, false)
                .expect_err("same revision conflict")
                .code(),
            "TEAM_PROJECT_KEY_RECEIPT_CONFLICT"
        );

        let newer = stored_team_receipt(10, "2026-07-28T02:00:00.000Z");
        assert!(matches!(
            classify_team_project_key_receipt_write(&current, &newer, false)
                .expect("newer authority"),
            TeamProjectKeyReceiptWriteState::Updated
        ));
        let newer_with_older_time = stored_team_receipt(10, "2026-07-28T01:58:00.000Z");
        assert_eq!(
            classify_team_project_key_receipt_write(&current, &newer_with_older_time, false)
                .expect_err("timestamp rollback")
                .code(),
            "TEAM_PROJECT_KEY_RECEIPT_ROLLBACK_BLOCKED"
        );
    }

    #[test]
    fn team_recipient_rewrap_rejects_scope_drift_and_duplicate_snapshots() {
        let mut rng = StdRng::from_seed([29_u8; 32]);
        let (source_sender_private, _) = DeviceKem::gen_keypair(&mut rng);
        let (current_device_private, current_device_public) = DeviceKem::gen_keypair(&mut rng);
        let (_, team_recipient_public) = DeviceKem::gen_keypair(&mut rng);
        let current_device_public_bytes = current_device_public.to_bytes();
        let team_recipient_public_bytes = team_recipient_public.to_bytes();
        let source_envelope = seal_device_envelope(
            WrapProjectDataKeyInput {
                envelope_id: SOURCE_ENVELOPE_ID.to_owned(),
                project_id: PROJECT_ID.to_owned(),
                key_version: 4,
                sender_device_id: SOURCE_SENDER_DEVICE_ID.to_owned(),
                recipient_device_id: SENDER_DEVICE_ID.to_owned(),
                recipient_public_key: URL_SAFE_NO_PAD.encode(current_device_public_bytes),
                recipient_public_key_fingerprint: sha256_hex(current_device_public_bytes.as_ref()),
                raw_project_data_key: URL_SAFE_NO_PAD.encode([31_u8; PROJECT_DATA_KEY_BYTES]),
            },
            &source_sender_private,
        )
        .expect("source envelope should seal");
        let recipient = TeamProjectKeyRecipientInput {
            envelope_id: ENVELOPE_ID.to_owned(),
            membership_id: MEMBERSHIP_ID.to_owned(),
            membership_revision: 7,
            assignment_id: ASSIGNMENT_ID.to_owned(),
            assignment_revision: 11,
            recipient_device_id: RECIPIENT_DEVICE_ID.to_owned(),
            recipient_public_key: URL_SAFE_NO_PAD.encode(team_recipient_public_bytes),
            recipient_public_key_fingerprint: sha256_hex(team_recipient_public_bytes.as_ref()),
        };

        let error = match rewrap_project_data_key_for_team_recipients_inner(
            RewrapProjectDataKeyForTeamRecipientsInput {
                team_id: TEAM_ID.to_owned(),
                project_id: PROJECT_ID.to_owned(),
                key_version: 5,
                sender_device_id: SENDER_DEVICE_ID.to_owned(),
                source_envelope: source_envelope.clone(),
                recipients: vec![recipient],
            },
            &current_device_private,
        ) {
            Ok(_) => panic!("key-version drift must fail closed"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "TEAM_PROJECT_KEY_RECIPIENT_SET_INVALID");

        let duplicate = TeamProjectKeyRecipientInput {
            envelope_id: ENVELOPE_ID.to_owned(),
            membership_id: MEMBERSHIP_ID.to_owned(),
            membership_revision: 7,
            assignment_id: ASSIGNMENT_ID.to_owned(),
            assignment_revision: 11,
            recipient_device_id: RECIPIENT_DEVICE_ID.to_owned(),
            recipient_public_key: URL_SAFE_NO_PAD.encode(team_recipient_public_bytes),
            recipient_public_key_fingerprint: sha256_hex(team_recipient_public_bytes.as_ref()),
        };
        let error = match rewrap_project_data_key_for_team_recipients_inner(
            RewrapProjectDataKeyForTeamRecipientsInput {
                team_id: TEAM_ID.to_owned(),
                project_id: PROJECT_ID.to_owned(),
                key_version: 4,
                sender_device_id: SENDER_DEVICE_ID.to_owned(),
                source_envelope,
                recipients: vec![
                    TeamProjectKeyRecipientInput {
                        envelope_id: SOURCE_ENVELOPE_ID.to_owned(),
                        ..duplicate
                    },
                    TeamProjectKeyRecipientInput {
                        envelope_id: RECOVERY_ID.to_owned(),
                        membership_id: MEMBERSHIP_ID.to_owned(),
                        membership_revision: 7,
                        assignment_id: SECOND_ASSIGNMENT_ID.to_owned(),
                        assignment_revision: 12,
                        recipient_device_id: RECIPIENT_DEVICE_ID.to_owned(),
                        recipient_public_key: URL_SAFE_NO_PAD.encode(team_recipient_public_bytes),
                        recipient_public_key_fingerprint: sha256_hex(
                            team_recipient_public_bytes.as_ref(),
                        ),
                    },
                ],
            },
            &current_device_private,
        ) {
            Ok(_) => panic!("duplicate recipient devices must fail closed"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "TEAM_PROJECT_KEY_RECIPIENT_SET_INVALID");
    }

    #[test]
    fn recovery_envelope_round_trips_and_rejects_wrong_code() {
        let raw_key = [17_u8; PROJECT_DATA_KEY_BYTES];
        let kit = create_recovery_kit_inner(CreateRecoveryKitInput {
            recovery_id: RECOVERY_ID.to_owned(),
            project_id: PROJECT_ID.to_owned(),
            key_version: 1,
            raw_project_data_key: URL_SAFE_NO_PAD.encode(raw_key),
        })
        .expect("recovery kit should be created");

        let recovered = recover_project_data_key_inner(VerifyRecoveryKitInput {
            recovery_code: kit.recovery_code.clone(),
            envelope: kit.envelope.clone(),
        })
        .expect("recovery code should open envelope");
        assert_eq!(recovered.as_slice(), raw_key);

        let wrong = format!(
            "{RECOVERY_CODE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode([1_u8; RECOVERY_SECRET_BYTES])
        );
        assert_eq!(
            recover_project_data_key_inner(VerifyRecoveryKitInput {
                recovery_code: wrong,
                envelope: kit.envelope,
            })
            .expect_err("wrong recovery code must fail")
            .code(),
            "RECOVERY_CODE_INVALID"
        );
    }

    fn stored_team_receipt(
        current_server_revision: u64,
        current_key_updated_at: &str,
    ) -> StoredTeamProjectKeyReceipt {
        let mut rng = StdRng::from_seed([41_u8; 32]);
        let (_, sender_public) = DeviceKem::gen_keypair(&mut rng);
        let (_, recipient_public) = DeviceKem::gen_keypair(&mut rng);
        let sender_bytes = sender_public.to_bytes();
        let recipient_bytes = recipient_public.to_bytes();
        StoredTeamProjectKeyReceipt {
            schema_version: 1,
            receipt_kind: TEAM_PROJECT_KEY_RECEIPT_KIND.to_owned(),
            account_id: ACCOUNT_ID.to_owned(),
            project_key_fingerprint: "f".repeat(64),
            current_server_revision,
            current_key_updated_at: current_key_updated_at.to_owned(),
            envelope: TeamProjectKeyEnvelope {
                schema_version: 1,
                envelope_kind: "team_project_member_device".to_owned(),
                envelope_id: ENVELOPE_ID.to_owned(),
                team_id: TEAM_ID.to_owned(),
                project_id: PROJECT_ID.to_owned(),
                key_version: 3,
                membership_id: MEMBERSHIP_ID.to_owned(),
                membership_revision: 7,
                assignment_id: ASSIGNMENT_ID.to_owned(),
                assignment_revision: 11,
                algorithm: DEVICE_ENVELOPE_ALGORITHM.to_owned(),
                sender_device_id: SENDER_DEVICE_ID.to_owned(),
                sender_public_key: URL_SAFE_NO_PAD.encode(sender_bytes),
                sender_public_key_fingerprint: sha256_hex(sender_bytes.as_ref()),
                recipient_device_id: RECIPIENT_DEVICE_ID.to_owned(),
                recipient_public_key: URL_SAFE_NO_PAD.encode(recipient_bytes),
                recipient_public_key_fingerprint: sha256_hex(recipient_bytes.as_ref()),
                encapsulated_key: URL_SAFE_NO_PAD.encode(sender_bytes),
                ciphertext: URL_SAFE_NO_PAD.encode([7_u8; HPKE_CIPHERTEXT_BYTES]),
                created_at: Some("2026-07-28T02:00:00.000Z".to_owned()),
            },
        }
    }
}
