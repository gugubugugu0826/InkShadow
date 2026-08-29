use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rand::RngCore;
use same_file::Handle;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::{fs, io::AsyncWriteExt};

use crate::model_gateway::CommandError;

const EXPORT_DESTINATION_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_EXPORT_BYTES: usize = 64 * 1_024 * 1_024;
const MAX_ENCODED_EXPORT_BYTES: usize = MAX_EXPORT_BYTES.div_ceil(3) * 4;
const MAX_ACTIVE_EXPORT_DESTINATIONS: usize = 32;
const MAX_FILE_NAME_BYTES: usize = 255;
const MAX_PATH_BYTES: usize = 32_767;
const TOKEN_HEX_BYTES: usize = 64;
const OPENABLE_EXPORT_EXTENSIONS: &[&str] = &["txt", "md", "json", "epub", "docx", "pdf"];

#[derive(Clone, Default)]
pub(crate) struct NativeExportDestinationState {
    inner: Arc<Mutex<ExportDestinationRegistry>>,
}

#[derive(Default)]
struct ExportDestinationRegistry {
    destinations: HashMap<String, ExportDestination>,
}

struct ExportDestination {
    path: PathBuf,
    parent_identity: Handle,
    selected_identity: Option<Handle>,
    format: ExportFormat,
    media_type: String,
    expires_at: Instant,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ExportFormat {
    Text,
    Markdown,
    Bundle,
    Epub,
    Docx,
    Pdf,
    Report,
}

impl ExportFormat {
    fn expected_media_type(self) -> &'static str {
        match self {
            Self::Text => "text/plain",
            Self::Markdown => "text/markdown",
            Self::Bundle | Self::Report => "application/json",
            Self::Epub => "application/epub+zip",
            Self::Docx => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            Self::Pdf => "application/pdf",
        }
    }

    fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Text => &["txt"],
            Self::Markdown => &["md"],
            Self::Bundle | Self::Report => &["json"],
            Self::Epub => &["epub"],
            Self::Docx => &["docx"],
            Self::Pdf => &["pdf"],
        }
    }

    fn filter_label(self) -> &'static str {
        match self {
            Self::Text => "纯文本文档",
            Self::Markdown => "Markdown 文档",
            Self::Bundle => "墨影项目包",
            Self::Epub => "EPUB 电子书",
            Self::Docx => "Word 文档",
            Self::Pdf => "PDF 文档",
            Self::Report => "结构化数据报告",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChooseExportDestinationRequest {
    default_file_name: String,
    format: ExportFormat,
    media_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportDestinationReceipt {
    ticket: String,
    file_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WriteExportArtifactRequest {
    destination_ticket: String,
    format: ExportFormat,
    media_type: String,
    expected_byte_length: usize,
    content_base64: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ExportOpenAction {
    OpenFile,
    ShowInFolder,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OpenExportArtifactRequest {
    path: String,
    action: ExportOpenAction,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportArtifactReceipt {
    format: ExportFormat,
    file_name: String,
    path: String,
    byte_length: usize,
    status: &'static str,
    verified: bool,
}

#[tauri::command]
pub(crate) async fn native_choose_export_destination(
    app: AppHandle,
    state: State<'_, NativeExportDestinationState>,
    request: ChooseExportDestinationRequest,
) -> Result<Option<ExportDestinationReceipt>, CommandError> {
    validate_choose_request(&request)?;
    let format = request.format;
    let default_file_name = request.default_file_name;
    let documents_directory = app.path().document_dir().ok();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let dialog = app
            .dialog()
            .file()
            .set_title("保存墨影导出文件")
            .set_file_name(default_file_name)
            .add_filter(format.filter_label(), format.extensions());
        let dialog = match documents_directory {
            Some(directory) => dialog.set_directory(directory),
            None => dialog,
        };
        dialog.blocking_save_file()
    })
    .await
    .map_err(|_| export_destination_error())?
    .map(|path| path.into_path())
    .transpose()
    .map_err(|_| export_destination_error())?;

    let Some(selected) = selected else {
        return Ok(None);
    };
    let mut registry = state.inner.lock().map_err(|_| export_destination_error())?;
    registry
        .issue(selected, request.format, request.media_type)
        .map(Some)
}

#[tauri::command]
pub(crate) async fn native_write_export_artifact(
    state: State<'_, NativeExportDestinationState>,
    request: WriteExportArtifactRequest,
) -> Result<ExportArtifactReceipt, CommandError> {
    validate_write_request(&request)?;
    let content = BASE64_STANDARD
        .decode(request.content_base64.as_bytes())
        .map_err(|_| export_content_error())?;
    if content.is_empty()
        || content.len() > MAX_EXPORT_BYTES
        || content.len() != request.expected_byte_length
    {
        return Err(export_content_error());
    }
    let destination = state
        .inner
        .lock()
        .map_err(|_| export_destination_error())?
        .take(
            &request.destination_ticket,
            request.format,
            &request.media_type,
        )?;

    let path = safe_receipt_path(&destination.path)?;
    let file_name = safe_file_name(&destination.path)?;
    write_and_verify(destination, &content).await?;
    Ok(ExportArtifactReceipt {
        format: request.format,
        file_name,
        path,
        byte_length: content.len(),
        status: "success",
        verified: true,
    })
}

#[tauri::command]
pub(crate) async fn native_open_export_artifact(
    request: OpenExportArtifactRequest,
) -> Result<(), CommandError> {
    let path = validate_open_export_path(&request.path)?;
    tauri::async_runtime::spawn_blocking(move || spawn_export_action(&path, request.action))
        .await
        .map_err(|_| export_open_error())?
        .map_err(|_| export_open_error())
}

fn validate_open_export_path(path: &str) -> Result<PathBuf, CommandError> {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.chars().any(char::is_control)
        || !Path::new(path).is_absolute()
    {
        return Err(export_open_error());
    }
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(export_open_error)?;
    if !OPENABLE_EXPORT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(export_open_error());
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| export_open_error())?;
    let metadata = std::fs::metadata(&canonical).map_err(|_| export_open_error())?;
    if !metadata.is_file()
        || canonical
            .as_os_str()
            .to_string_lossy()
            .chars()
            .any(char::is_control)
    {
        return Err(export_open_error());
    }
    Ok(canonical)
}

#[cfg(target_os = "windows")]
fn spawn_export_action(path: &Path, action: ExportOpenAction) -> std::io::Result<()> {
    let mut command = Command::new("explorer.exe");
    if action == ExportOpenAction::ShowInFolder {
        command.arg("/select,");
    }
    command.arg(path).spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn spawn_export_action(path: &Path, action: ExportOpenAction) -> std::io::Result<()> {
    let mut command = Command::new("open");
    if action == ExportOpenAction::ShowInFolder {
        command.arg("-R");
    }
    command.arg(path).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_export_action(path: &Path, action: ExportOpenAction) -> std::io::Result<()> {
    let target = if action == ExportOpenAction::ShowInFolder {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    Command::new("xdg-open").arg(target).spawn().map(|_| ())
}

impl ExportDestinationRegistry {
    fn issue(
        &mut self,
        selected: PathBuf,
        format: ExportFormat,
        media_type: String,
    ) -> Result<ExportDestinationReceipt, CommandError> {
        self.purge_expired();
        if self.destinations.len() >= MAX_ACTIVE_EXPORT_DESTINATIONS
            || !valid_path_shape(&selected)
            || media_type != format.expected_media_type()
        {
            return Err(export_destination_error());
        }
        let file_name = safe_file_name(&selected)?;
        if !has_expected_extension(&file_name, format) {
            return Err(export_destination_error());
        }
        let parent = selected.parent().ok_or_else(export_destination_error)?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|_| export_destination_error())?;
        if !canonical_parent.is_dir() {
            return Err(export_destination_error());
        }
        let normalized = canonical_parent.join(&file_name);
        let selected_identity = match normalized.symlink_metadata() {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(export_destination_error());
                }
                Some(Handle::from_path(&normalized).map_err(|_| export_destination_error())?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(export_destination_error()),
        };
        let token = random_token();
        self.destinations.insert(
            token.clone(),
            ExportDestination {
                path: normalized,
                parent_identity: Handle::from_path(&canonical_parent)
                    .map_err(|_| export_destination_error())?,
                selected_identity,
                format,
                media_type,
                expires_at: Instant::now() + EXPORT_DESTINATION_TTL,
            },
        );
        Ok(ExportDestinationReceipt {
            ticket: token,
            file_name,
        })
    }

    fn take(
        &mut self,
        token: &str,
        format: ExportFormat,
        media_type: &str,
    ) -> Result<ExportDestination, CommandError> {
        self.purge_expired();
        if !valid_ticket_token(token) {
            return Err(export_destination_error());
        }
        let destination = self
            .destinations
            .remove(token)
            .ok_or_else(export_destination_error)?;
        if destination.expires_at <= Instant::now()
            || destination.format != format
            || destination.media_type != media_type
        {
            return Err(export_destination_error());
        }
        validate_destination_identity(&destination, export_destination_error)?;
        Ok(destination)
    }

    fn purge_expired(&mut self) {
        let now = Instant::now();
        self.destinations
            .retain(|_, destination| destination.expires_at > now);
    }
}

fn validate_destination_identity(
    destination: &ExportDestination,
    error: fn() -> CommandError,
) -> Result<(), CommandError> {
    let parent = destination.path.parent().ok_or_else(error)?;
    let parent_metadata = parent.symlink_metadata().map_err(|_| error())?;
    if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
        return Err(error());
    }
    let current_parent = Handle::from_path(parent).map_err(|_| error())?;
    if current_parent != destination.parent_identity {
        return Err(error());
    }

    match &destination.selected_identity {
        Some(expected) => {
            let metadata = destination.path.symlink_metadata().map_err(|_| error())?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || Handle::from_path(&destination.path).map_err(|_| error())? != *expected
            {
                return Err(error());
            }
        }
        None => match destination.path.symlink_metadata() {
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(error()),
        },
    }
    Ok(())
}

fn validate_choose_request(request: &ChooseExportDestinationRequest) -> Result<(), CommandError> {
    if request.media_type != request.format.expected_media_type()
        || !is_safe_file_name(&request.default_file_name)
        || !has_expected_extension(&request.default_file_name, request.format)
    {
        return Err(export_destination_error());
    }
    Ok(())
}

fn validate_write_request(request: &WriteExportArtifactRequest) -> Result<(), CommandError> {
    if request.media_type != request.format.expected_media_type()
        || !valid_ticket_token(&request.destination_ticket)
        || request.expected_byte_length == 0
        || request.expected_byte_length > MAX_EXPORT_BYTES
        || request.content_base64.is_empty()
        || request.content_base64.len() > MAX_ENCODED_EXPORT_BYTES
    {
        return Err(export_content_error());
    }
    Ok(())
}

async fn write_and_verify(
    destination: ExportDestination,
    content: &[u8],
) -> Result<(), CommandError> {
    write_and_verify_with_hooks(destination, content, |_| {}, |_| {}).await
}

async fn write_and_verify_with_hooks<BeforeInstall, AfterInstall>(
    destination: ExportDestination,
    content: &[u8],
    before_install: BeforeInstall,
    after_install: AfterInstall,
) -> Result<(), CommandError>
where
    BeforeInstall: FnOnce(&Path),
    AfterInstall: FnOnce(&Path),
{
    let path = destination.path.clone();
    let parent = path.parent().ok_or_else(export_save_error)?;
    let temporary = parent.join(format!(".inkshadow-export-{}.tmp", random_token()));
    let result = async {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await
            .map_err(|_| export_save_error())?;
        file.write_all(content)
            .await
            .map_err(|_| export_save_error())?;
        file.flush().await.map_err(|_| export_save_error())?;
        file.sync_all().await.map_err(|_| export_save_error())?;
        drop(file);

        let staged = fs::read(&temporary)
            .await
            .map_err(|_| export_save_error())?;
        if staged.len() != content.len() || Sha256::digest(&staged) != Sha256::digest(content) {
            return Err(export_save_error());
        }
        before_install(&path);
        atomic_install(&temporary, destination).await?;
        after_install(&path);
        let saved = fs::read(&path)
            .await
            .map_err(|_| export_save_outcome_unknown_error())?;
        let metadata = fs::metadata(&path)
            .await
            .map_err(|_| export_save_outcome_unknown_error())?;
        if !metadata.is_file()
            || metadata.len() != content.len() as u64
            || saved.len() != content.len()
            || Sha256::digest(&saved) != Sha256::digest(content)
        {
            return Err(export_save_outcome_unknown_error());
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&temporary).await;
    }
    result
}

#[cfg(not(windows))]
async fn atomic_install(
    temporary: &Path,
    destination: ExportDestination,
) -> Result<(), CommandError> {
    let temporary = temporary.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        validate_destination_identity(&destination, export_save_error)?;
        if destination.selected_identity.is_some() {
            return std::fs::rename(&temporary, &destination.path).map_err(|_| export_save_error());
        }
        std::fs::hard_link(&temporary, &destination.path).map_err(|_| export_save_error())?;
        std::fs::remove_file(&temporary).map_err(|_| export_save_error())
    })
    .await
    .map_err(|_| export_save_error())?
}

#[cfg(windows)]
async fn atomic_install(
    temporary: &Path,
    destination: ExportDestination,
) -> Result<(), CommandError> {
    let temporary = temporary.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        validate_destination_identity(&destination, export_save_error)?;
        if destination.selected_identity.is_some() {
            replace_file(&destination.path, &temporary)
        } else {
            move_new_file(&temporary, &destination.path)
        }
    })
    .await
    .map_err(|_| export_save_error())?
}

#[cfg(windows)]
fn replace_file(destination: &Path, replacement: &Path) -> Result<(), CommandError> {
    use std::{iter, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let replacement = replacement
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both paths are owned, nul-terminated UTF-16 buffers that remain
    // alive for the duration of the call. The destination was issued by the
    // native save dialog and revalidated immediately before this replacement.
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            replacement.as_ptr(),
            ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            ptr::null(),
            ptr::null(),
        )
    };
    if replaced == 0 {
        Err(export_save_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn move_new_file(source: &Path, destination: &Path) -> Result<(), CommandError> {
    use std::{iter, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both paths are owned, nul-terminated UTF-16 buffers that remain
    // alive for the duration of the call. Omitting MOVEFILE_REPLACE_EXISTING is
    // the native no-clobber boundary for a destination selected as new.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(export_save_error())
    } else {
        Ok(())
    }
}

fn safe_file_name(path: &Path) -> Result<String, CommandError> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(export_destination_error)?;
    if is_safe_file_name(name) {
        Ok(name.to_owned())
    } else {
        Err(export_destination_error())
    }
}

fn is_safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= MAX_FILE_NAME_BYTES
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(|character| character.is_control())
}

fn has_expected_extension(file_name: &str, format: ExportFormat) -> bool {
    let lower = file_name.to_lowercase();
    format
        .extensions()
        .iter()
        .any(|extension| lower.ends_with(&format!(".{extension}")))
}

fn valid_path_shape(path: &Path) -> bool {
    path.is_absolute()
        && path.as_os_str().to_string_lossy().len() <= MAX_PATH_BYTES
        && !path
            .as_os_str()
            .to_string_lossy()
            .chars()
            .any(|character| character.is_control())
}

fn safe_receipt_path(path: &Path) -> Result<String, CommandError> {
    if !valid_path_shape(path) {
        return Err(export_save_error());
    }
    let value = path.as_os_str().to_string_lossy();
    #[cfg(windows)]
    let value = value
        .strip_prefix(r"\\?\UNC\")
        .map(|path| format!(r"\\{path}"))
        .or_else(|| value.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| value.into_owned());
    #[cfg(not(windows))]
    let value = value.into_owned();
    Ok(value)
}

fn valid_ticket_token(value: &str) -> bool {
    value.len() == TOKEN_HEX_BYTES && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut token = String::with_capacity(TOKEN_HEX_BYTES);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(token, "{byte:02x}");
    }
    token
}

fn export_destination_error() -> CommandError {
    CommandError::new(
        "EXPORT_DESTINATION_INVALID",
        "The selected export destination is unavailable.",
        false,
        vec!["CHOOSE_EXPORT_DESTINATION"],
    )
}

fn export_content_error() -> CommandError {
    CommandError::new(
        "EXPORT_CONTENT_INVALID",
        "The generated export artifact could not be validated.",
        false,
        vec!["REGENERATE_EXPORT"],
    )
}

fn export_save_error() -> CommandError {
    CommandError::new(
        "EXPORT_SAVE_FAILED",
        "The export artifact could not be saved and verified.",
        true,
        vec!["CHOOSE_EXPORT_DESTINATION", "RETRY"],
    )
}

fn export_save_outcome_unknown_error() -> CommandError {
    CommandError::new(
        "EXPORT_SAVE_OUTCOME_UNKNOWN",
        "The export artifact may have been written, but the final result could not be verified.",
        false,
        vec!["CHECK_EXPORT_DESTINATION", "CHOOSE_EXPORT_DESTINATION"],
    )
}

fn export_open_error() -> CommandError {
    CommandError::new(
        "EXPORT_OPEN_FAILED",
        "The saved export artifact could not be opened.",
        true,
        vec!["OPEN_EXPORT_LOCATION"],
    )
}

#[cfg(test)]
mod tests {
    use std::{fs as std_fs, path::PathBuf};

    use super::{
        random_token, safe_receipt_path, validate_choose_request, validate_open_export_path,
        write_and_verify, write_and_verify_with_hooks, ChooseExportDestinationRequest,
        ExportDestinationRegistry, ExportFormat, TOKEN_HEX_BYTES,
    };

    #[test]
    fn uses_accurate_chinese_filter_labels() {
        assert_eq!(ExportFormat::Report.filter_label(), "结构化数据报告");
        assert_eq!(ExportFormat::Bundle.filter_label(), "墨影项目包");
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create() -> Self {
            let path = std::env::temp_dir().join(format!("inkshadow-export-{}", random_token()));
            std_fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std_fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn every_ui_export_format_has_an_exact_native_media_and_extension_contract() {
        for (format, file_name, media_type) in [
            (ExportFormat::Text, "长篇.txt", "text/plain"),
            (ExportFormat::Markdown, "长篇.md", "text/markdown"),
            (
                ExportFormat::Bundle,
                "长篇.inkshadow.json",
                "application/json",
            ),
            (ExportFormat::Epub, "长篇.epub", "application/epub+zip"),
            (
                ExportFormat::Docx,
                "长篇.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
            (ExportFormat::Pdf, "长篇.pdf", "application/pdf"),
            (ExportFormat::Report, "长篇-报告.json", "application/json"),
        ] {
            assert!(validate_choose_request(&ChooseExportDestinationRequest {
                default_file_name: file_name.to_owned(),
                format,
                media_type: media_type.to_owned(),
            })
            .is_ok());
            assert!(validate_choose_request(&ChooseExportDestinationRequest {
                default_file_name: file_name.to_owned(),
                format,
                media_type: "application/octet-stream".to_owned(),
            })
            .is_err());
        }
    }

    #[test]
    fn saved_export_actions_accept_only_existing_supported_files() {
        let directory = TestDirectory::create();
        let markdown = directory.0.join("作品定稿.md");
        std_fs::write(&markdown, b"verified export").expect("write supported export");
        assert_eq!(
            validate_open_export_path(markdown.to_string_lossy().as_ref())
                .expect("validate supported export"),
            std_fs::canonicalize(&markdown).expect("canonical export")
        );

        let executable = directory.0.join("not-an-export.exe");
        std_fs::write(&executable, b"MZ").expect("write rejected executable");
        assert!(validate_open_export_path(executable.to_string_lossy().as_ref()).is_err());
        assert!(validate_open_export_path("relative.md").is_err());
        assert!(validate_open_export_path(directory.0.to_string_lossy().as_ref()).is_err());
    }

    #[tokio::test]
    async fn ticket_is_single_use_and_written_bytes_are_verified_from_disk() {
        let directory = TestDirectory::create();
        let path = directory.0.join("长篇定稿.md");
        let mut registry = ExportDestinationRegistry::default();
        let receipt = registry
            .issue(
                path.clone(),
                ExportFormat::Markdown,
                "text/markdown".to_owned(),
            )
            .expect("issue destination");
        let destination = registry
            .take(&receipt.ticket, ExportFormat::Markdown, "text/markdown")
            .expect("consume destination");
        let displayed_path = safe_receipt_path(&destination.path).expect("safe receipt path");
        assert!(PathBuf::from(&displayed_path).is_absolute());
        assert!(!displayed_path.starts_with(r"\\?\"));
        assert!(registry
            .take(&receipt.ticket, ExportFormat::Markdown, "text/markdown")
            .is_err());

        write_and_verify(destination, "第一章\n雨落长街。".as_bytes())
            .await
            .expect("write verified export");
        assert_eq!(
            std_fs::read_to_string(path).expect("read exported file"),
            "第一章\n雨落长街。"
        );
    }

    #[tokio::test]
    async fn a_dialog_selected_existing_file_is_replaced_without_partial_content() {
        let directory = TestDirectory::create();
        let path = directory.0.join("定稿.pdf");
        std_fs::write(&path, b"old complete file").expect("seed existing file");
        let mut registry = ExportDestinationRegistry::default();
        let receipt = registry
            .issue(
                path.clone(),
                ExportFormat::Pdf,
                "application/pdf".to_owned(),
            )
            .expect("issue replacement destination");
        let destination = registry
            .take(&receipt.ticket, ExportFormat::Pdf, "application/pdf")
            .expect("consume destination");
        write_and_verify(destination, b"%PDF-1.7\nverified")
            .await
            .expect("replace export");
        assert_eq!(
            std_fs::read(path).expect("read replacement"),
            b"%PDF-1.7\nverified"
        );
    }

    #[tokio::test]
    async fn a_new_destination_created_after_ticket_consumption_is_never_overwritten() {
        let directory = TestDirectory::create();
        let path = directory.0.join("竞态保护.epub");
        let mut registry = ExportDestinationRegistry::default();
        let receipt = registry
            .issue(
                path.clone(),
                ExportFormat::Epub,
                "application/epub+zip".to_owned(),
            )
            .expect("issue new destination");
        let destination = registry
            .take(&receipt.ticket, ExportFormat::Epub, "application/epub+zip")
            .expect("consume new destination");
        let competing_path = path.clone();
        assert!(write_and_verify_with_hooks(
            destination,
            b"PK export",
            move |_| {
                std_fs::write(&competing_path, b"unrelated file created after selection")
                    .expect("create competing file");
            },
            |_| {},
        )
        .await
        .is_err());
        assert_eq!(
            std_fs::read(path).expect("read competing file"),
            b"unrelated file created after selection"
        );
    }

    #[tokio::test]
    async fn a_recreated_existing_destination_is_not_replaced_after_staging() {
        let directory = TestDirectory::create();
        let path = directory.0.join("竞态替身.pdf");
        std_fs::write(&path, b"dialog-selected file").expect("seed selected file");
        let mut registry = ExportDestinationRegistry::default();
        let receipt = registry
            .issue(
                path.clone(),
                ExportFormat::Pdf,
                "application/pdf".to_owned(),
            )
            .expect("issue replacement destination");
        let destination = registry
            .take(&receipt.ticket, ExportFormat::Pdf, "application/pdf")
            .expect("consume replacement destination");
        let competing_path = path.clone();

        let error = write_and_verify_with_hooks(
            destination,
            b"%PDF-1.7\nnew export",
            move |_| {
                std_fs::remove_file(&competing_path).expect("remove selected file during staging");
                std_fs::write(&competing_path, b"unrelated recreated file")
                    .expect("create replacement identity");
            },
            |_| {},
        )
        .await
        .expect_err("recreated destination must fail closed");

        assert_eq!(error.code(), "EXPORT_SAVE_FAILED");
        assert_eq!(
            std_fs::read(path).expect("read recreated file"),
            b"unrelated recreated file"
        );
    }

    #[tokio::test]
    async fn a_replaced_parent_directory_is_not_used_for_final_install() {
        let directory = TestDirectory::create();
        let selected_parent = directory.0.join("selected-parent");
        let original_parent = directory.0.join("original-parent");
        std_fs::create_dir(&selected_parent).expect("create selected parent");
        let path = selected_parent.join("目录竞态.docx");
        let mut registry = ExportDestinationRegistry::default();
        let receipt = registry
            .issue(
                path.clone(),
                ExportFormat::Docx,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    .to_owned(),
            )
            .expect("issue parent race destination");
        let destination = registry
            .take(
                &receipt.ticket,
                ExportFormat::Docx,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
            .expect("consume parent race destination");
        let selected_parent_for_race = selected_parent.clone();
        let original_parent_for_race = original_parent.clone();

        let error = write_and_verify_with_hooks(
            destination,
            b"PK parent-safe export",
            move |_| {
                std_fs::rename(&selected_parent_for_race, &original_parent_for_race)
                    .expect("move selected parent during staging");
                std_fs::create_dir(&selected_parent_for_race)
                    .expect("create replacement parent identity");
            },
            |_| {},
        )
        .await
        .expect_err("replacement parent must fail closed");

        assert_eq!(error.code(), "EXPORT_SAVE_FAILED");
        assert!(!path.exists());
        assert!(!original_parent.join("目录竞态.docx").exists());
    }

    #[tokio::test]
    async fn a_post_install_verification_failure_reports_an_unknown_write_outcome() {
        let directory = TestDirectory::create();
        let path = directory.0.join("private-post-install.pdf");
        let mut registry = ExportDestinationRegistry::default();
        let receipt = registry
            .issue(
                path.clone(),
                ExportFormat::Pdf,
                "application/pdf".to_owned(),
            )
            .expect("issue unknown-outcome destination");
        let destination = registry
            .take(&receipt.ticket, ExportFormat::Pdf, "application/pdf")
            .expect("consume unknown-outcome destination");

        let error = write_and_verify_with_hooks(
            destination,
            b"%PDF-1.7\ninstalled",
            |_| {},
            |installed_path| {
                std_fs::write(installed_path, b"changed after install")
                    .expect("change installed artifact before verification");
            },
        )
        .await
        .expect_err("post-install mismatch must be reported as unknown");

        assert_eq!(error.code(), "EXPORT_SAVE_OUTCOME_UNKNOWN");
        assert!(!error.retryable());
        let serialized = serde_json::to_string(&error).expect("serialize unknown-outcome error");
        assert!(!serialized.contains("private-post-install.pdf"));
        assert!(!serialized.contains(&directory.0.to_string_lossy().to_string()));
    }

    #[test]
    fn rejects_raw_paths_mismatched_formats_and_path_leaks_in_errors() {
        let directory = TestDirectory::create();
        let path = directory.0.join("private-name.docx");
        let mut registry = ExportDestinationRegistry::default();
        let receipt = registry
            .issue(
                path.clone(),
                ExportFormat::Docx,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    .to_owned(),
            )
            .expect("issue docx destination");
        assert!(registry
            .take(&receipt.ticket, ExportFormat::Docx, "application/pdf")
            .is_err());
        let second = registry
            .issue(
                path.clone(),
                ExportFormat::Docx,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    .to_owned(),
            )
            .expect("issue raw path test destination");
        let raw_path = path.to_string_lossy();
        assert!(
            raw_path.len() != TOKEN_HEX_BYTES
                || !raw_path.bytes().all(|byte| byte.is_ascii_hexdigit())
        );
        assert!(registry
            .take(
                &raw_path,
                ExportFormat::Docx,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
            .is_err());
        assert!(registry
            .take(
                &second.ticket,
                ExportFormat::Docx,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
            .is_ok());

        let error = registry
            .issue(
                directory.0.join("wrong.pdf"),
                ExportFormat::Docx,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    .to_owned(),
            )
            .expect_err("extension mismatch");
        let serialized = serde_json::to_string(&error).expect("serialize safe error");
        assert!(!serialized.contains("wrong.pdf"));
        assert!(!serialized.contains(directory.0.to_string_lossy().as_ref()));
    }
}
