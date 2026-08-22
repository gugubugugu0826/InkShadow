use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use super::{
    error::CommandError,
    gateway::{configured_request_timeout, load_credential, validate_config, ModelGatewayState},
    types::{GenerationUsage, ModelEndpointConfig, ProviderKind},
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rand::RngCore;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use same_file::Handle;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::{fs::OpenOptions, io::AsyncWriteExt, time::timeout};

const IMAGE_DESTINATION_TTL: Duration = Duration::from_secs(5 * 60);
const IMAGE_RESPONSE_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_PROMPT_CHARACTERS: usize = 1_000;
const MAX_PROMPT_BYTES: usize = 64 * 1_024;
const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_RESPONSE_BYTES: usize = 64 * 1_024 * 1_024;
const MAX_IMAGE_BYTES: usize = 48 * 1_024 * 1_024;
const MAX_IMAGE_EDGE: u32 = 8_192;
const DEFAULT_GENERATED_IMAGE_FILE_NAME: &str = "墨影图片.png";
const GENERATED_IMAGE_FILTER_LABEL: &str = "PNG 图片";
const MAX_IMAGE_PIXELS: u64 = 32 * 1_024 * 1_024;
const TOKEN_HEX_BYTES: usize = 64;

#[derive(Clone, Default)]
pub(crate) struct NativeImageDestinationState {
    inner: Arc<Mutex<ImageDestinationRegistry>>,
}

#[derive(Default)]
struct ImageDestinationRegistry {
    destinations: HashMap<String, ImageDestination>,
}

struct ImageDestination {
    path: PathBuf,
    parent_identity: Handle,
    expires_at: Instant,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageDestinationReceipt {
    ticket: String,
    file_name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GenerateImageToFileRequest {
    destination_ticket: String,
    config: ModelEndpointConfig,
    model: String,
    prompt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedImageFileReceipt {
    provider: ProviderKind,
    endpoint_origin: String,
    model: String,
    file_name: String,
    media_type: &'static str,
    bytes_written: usize,
    usage: Option<GenerationUsage>,
}

#[derive(Serialize)]
struct OpenAiImageGenerationBody<'a> {
    model: &'a str,
    prompt: &'a str,
    n: u8,
}

#[derive(Deserialize)]
struct OpenAiImagesResponse {
    #[serde(default)]
    data: Vec<OpenAiImageData>,
    usage: Option<OpenAiImageUsage>,
}

#[derive(Deserialize)]
struct OpenAiImageData {
    b64_json: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiImageUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

struct ParsedImage {
    bytes: Vec<u8>,
    usage: Option<GenerationUsage>,
}

#[tauri::command]
pub(crate) async fn choose_native_image_destination(
    app: AppHandle,
    state: State<'_, NativeImageDestinationState>,
) -> Result<Option<ImageDestinationReceipt>, CommandError> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("保存墨影生成的图片")
            .set_file_name(DEFAULT_GENERATED_IMAGE_FILE_NAME)
            .add_filter(GENERATED_IMAGE_FILTER_LABEL, &["png"])
            .blocking_save_file()
    })
    .await
    .map_err(|_| image_destination_error())?
    .map(|path| path.into_path())
    .transpose()
    .map_err(|_| image_destination_error())?;

    let Some(selected) = selected else {
        return Ok(None);
    };
    let mut registry = state.inner.lock().map_err(|_| image_destination_error())?;
    registry.issue(selected).map(Some)
}

#[tauri::command]
pub(crate) async fn generate_native_image_to_file(
    gateway: State<'_, ModelGatewayState>,
    destinations: State<'_, NativeImageDestinationState>,
    request: GenerateImageToFileRequest,
) -> Result<GeneratedImageFileReceipt, CommandError> {
    validate_request(&request)?;
    let endpoint = validate_config(&request.config)?;
    let credential = load_credential(&request.config).await?;
    let request_timeout = configured_request_timeout(&request.config)?;
    let (destination, file_name) = destinations
        .inner
        .lock()
        .map_err(|_| image_destination_error())?
        .take(&request.destination_ticket)?;

    let body = serde_json::to_vec(&OpenAiImageGenerationBody {
        model: &request.model,
        prompt: &request.prompt,
        n: 1,
    })
    .map_err(|_| CommandError::request_invalid())?;
    if body.len() > MAX_PROMPT_BYTES + 4 * 1_024 {
        return Err(CommandError::input_limit_exceeded());
    }

    let mut outbound = gateway
        .client
        .post(endpoint.api_url("/images/generations")?)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json")
        .body(body);
    if let Some(credential) = credential {
        outbound = outbound.header(credential.name, credential.value);
    }

    let response = timeout(request_timeout, outbound.send())
        .await
        .map_err(|_| CommandError::timeout())?
        .map_err(|error| CommandError::from_reqwest(&error))?;
    if !response.status().is_success() {
        return Err(CommandError::from_http_status(response.status()));
    }
    let response_body = collect_limited_body(response).await?;
    let parsed = parse_image_response(&response_body)?;
    write_new_file(&destination, &parsed.bytes).await?;

    Ok(GeneratedImageFileReceipt {
        provider: request.config.provider,
        endpoint_origin: endpoint.origin(),
        model: request.model,
        file_name,
        media_type: "image/png",
        bytes_written: parsed.bytes.len(),
        usage: parsed.usage,
    })
}

impl ImageDestinationRegistry {
    fn issue(&mut self, selected: PathBuf) -> Result<ImageDestinationReceipt, CommandError> {
        self.purge_expired();
        if !selected.is_absolute()
            || selected.as_os_str().to_string_lossy().contains('\0')
            || selected.exists()
            || selected
                .extension()
                .and_then(|extension| extension.to_str())
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("png"))
        {
            return Err(image_destination_error());
        }
        let file_name = selected
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty() && name.len() <= 255)
            .ok_or_else(image_destination_error)?
            .to_owned();
        let parent = selected.parent().ok_or_else(image_destination_error)?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|_| image_destination_error())?;
        if !canonical_parent.is_dir() {
            return Err(image_destination_error());
        }
        let normalized = canonical_parent.join(&file_name);
        if normalized.exists() {
            return Err(image_destination_error());
        }
        let token = random_token();
        self.destinations.insert(
            token.clone(),
            ImageDestination {
                path: normalized,
                parent_identity: Handle::from_path(canonical_parent)
                    .map_err(|_| image_destination_error())?,
                expires_at: Instant::now() + IMAGE_DESTINATION_TTL,
            },
        );
        Ok(ImageDestinationReceipt {
            ticket: token,
            file_name,
        })
    }

    fn take(&mut self, token: &str) -> Result<(PathBuf, String), CommandError> {
        self.purge_expired();
        if !valid_ticket_token(token) {
            return Err(image_destination_error());
        }
        let destination = self
            .destinations
            .remove(token)
            .ok_or_else(image_destination_error)?;
        if destination.expires_at <= Instant::now() || destination.path.exists() {
            return Err(image_destination_error());
        }
        let parent = destination
            .path
            .parent()
            .ok_or_else(image_destination_error)?;
        let current_parent = Handle::from_path(parent).map_err(|_| image_destination_error())?;
        if current_parent != destination.parent_identity {
            return Err(image_destination_error());
        }
        let file_name = destination
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(image_destination_error)?
            .to_owned();
        Ok((destination.path, file_name))
    }

    fn purge_expired(&mut self) {
        let now = Instant::now();
        self.destinations
            .retain(|_, destination| destination.expires_at > now);
    }
}

fn validate_request(request: &GenerateImageToFileRequest) -> Result<(), CommandError> {
    if request.config.provider != ProviderKind::OpenAiCompatible {
        return Err(CommandError::operation_unsupported());
    }
    validate_safe_text(&request.model, MAX_MODEL_ID_BYTES)?;
    if request.prompt.trim() != request.prompt
        || request.prompt.is_empty()
        || request.prompt.chars().count() > MAX_PROMPT_CHARACTERS
        || request.prompt.len() > MAX_PROMPT_BYTES
        || request.prompt.chars().any(invalid_text_character)
    {
        return Err(CommandError::request_invalid());
    }
    if !valid_ticket_token(&request.destination_ticket) {
        return Err(image_destination_error());
    }
    Ok(())
}

fn validate_safe_text(value: &str, maximum_bytes: usize) -> Result<(), CommandError> {
    if value.is_empty()
        || value.len() > maximum_bytes
        || value.trim() != value
        || value.chars().any(invalid_text_character)
    {
        Err(CommandError::request_invalid())
    } else {
        Ok(())
    }
}

fn invalid_text_character(character: char) -> bool {
    character == '\u{7f}' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

async fn collect_limited_body(mut response: reqwest::Response) -> Result<Vec<u8>, CommandError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(CommandError::response_limit_exceeded());
    }
    let mut body = Vec::new();
    loop {
        let chunk = timeout(IMAGE_RESPONSE_IDLE_TIMEOUT, response.chunk())
            .await
            .map_err(|_| CommandError::timeout())?
            .map_err(|error| CommandError::from_reqwest(&error))?;
        let Some(chunk) = chunk else {
            return Ok(body);
        };
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(CommandError::response_limit_exceeded());
        }
        body.extend_from_slice(&chunk);
    }
}

fn parse_image_response(body: &[u8]) -> Result<ParsedImage, CommandError> {
    let response: OpenAiImagesResponse =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    if response.data.len() != 1 {
        return Err(CommandError::response_invalid());
    }
    let image = response.data.into_iter().next().expect("one item checked");
    let encoded = match image.b64_json {
        Some(value) if !value.is_empty() && value.len() <= MAX_RESPONSE_BYTES => value,
        _ if image.url.is_some() => return Err(image_url_response_error()),
        _ => return Err(CommandError::response_invalid()),
    };
    let bytes = BASE64_STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| CommandError::response_invalid())?;
    validate_png(&bytes)?;
    let usage = response
        .usage
        .map(|usage| {
            Ok(GenerationUsage {
                input_tokens: checked_usage_token(usage.input_tokens.unwrap_or(0))?,
                output_tokens: checked_usage_token(usage.output_tokens.unwrap_or(0))?,
                cached_input_tokens: None,
            })
        })
        .transpose()?;
    Ok(ParsedImage { bytes, usage })
}

fn checked_usage_token(value: u64) -> Result<u32, CommandError> {
    if value > 100_000_000 {
        Err(CommandError::response_invalid())
    } else {
        Ok(value as u32)
    }
}

fn validate_png(bytes: &[u8]) -> Result<(), CommandError> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 45 || bytes.len() > MAX_IMAGE_BYTES || &bytes[..8] != SIGNATURE {
        return Err(CommandError::response_invalid());
    }
    if u32::from_be_bytes(bytes[8..12].try_into().expect("fixed slice")) != 13
        || &bytes[12..16] != b"IHDR"
    {
        return Err(CommandError::response_invalid());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("fixed slice"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("fixed slice"));
    if width == 0
        || height == 0
        || width > MAX_IMAGE_EDGE
        || height > MAX_IMAGE_EDGE
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
        || &bytes[bytes.len() - 8..bytes.len() - 4] != b"IEND"
    {
        return Err(CommandError::response_invalid());
    }
    Ok(())
}

async fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|_| image_save_error())?;
    if file.write_all(bytes).await.is_err() || file.sync_all().await.is_err() {
        drop(file);
        let _ = tokio::fs::remove_file(path).await;
        return Err(image_save_error());
    }
    Ok(())
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_ticket_token(value: &str) -> bool {
    value.len() == TOKEN_HEX_BYTES && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn image_destination_error() -> CommandError {
    CommandError::new(
        "MODEL_IMAGE_DESTINATION_INVALID",
        "Choose a new PNG file in an existing folder before generating the image.",
        false,
        vec!["CHOOSE_IMAGE_DESTINATION"],
    )
}

fn image_url_response_error() -> CommandError {
    CommandError::new(
        "MODEL_IMAGE_URL_RESPONSE_UNSUPPORTED",
        "The provider returned a temporary image URL instead of base64 PNG data.",
        false,
        vec!["SWITCH_MODEL", "EDIT_MODEL_CONFIG"],
    )
}

fn image_save_error() -> CommandError {
    CommandError::new(
        "MODEL_IMAGE_SAVE_FAILED",
        "The generated image could not be saved to the selected file.",
        true,
        vec!["CHOOSE_IMAGE_DESTINATION", "CHECK_DISK_SPACE"],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_gateway::types::AuthenticationMode;
    use std::fs;

    // A valid one-pixel PNG. Provider bytes are still verified before any file is created.
    const ONE_PIXEL_PNG_BASE64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    #[test]
    fn uses_chinese_image_dialog_defaults() {
        assert_eq!(DEFAULT_GENERATED_IMAGE_FILE_NAME, "墨影图片.png");
        assert_eq!(GENERATED_IMAGE_FILTER_LABEL, "PNG 图片");
    }

    #[test]
    fn parses_one_base64_png_and_bounded_usage_without_echoing_provider_text() {
        let body = format!(
            r#"{{"created":1,"data":[{{"b64_json":"{ONE_PIXEL_PNG_BASE64}","revised_prompt":"private rewrite"}}],"usage":{{"input_tokens":7,"output_tokens":11}}}}"#
        );
        let parsed = parse_image_response(body.as_bytes()).expect("valid response");
        assert!(parsed.bytes.starts_with(b"\x89PNG"));
        assert_eq!(
            parsed.usage,
            Some(GenerationUsage {
                input_tokens: 7,
                output_tokens: 11,
                cached_input_tokens: None,
            })
        );
    }

    #[test]
    fn rejects_url_only_multiple_non_png_and_corrupt_base64_responses() {
        for body in [
            r#"{"data":[{"url":"https://temporary.example/image.png"}]}"#.to_owned(),
            format!(
                r#"{{"data":[{{"b64_json":"{ONE_PIXEL_PNG_BASE64}"}},{{"b64_json":"{ONE_PIXEL_PNG_BASE64}"}}]}}"#
            ),
            r#"{"data":[{"b64_json":"bm90IGEgcG5n"}]}"#.to_owned(),
            r#"{"data":[{"b64_json":"%%%"}]}"#.to_owned(),
        ] {
            assert!(parse_image_response(body.as_bytes()).is_err());
        }
    }

    #[test]
    fn destination_ticket_is_single_use_and_refuses_existing_files() {
        let directory = std::env::temp_dir().join(format!("inkshadow-image-{}", random_token()));
        fs::create_dir_all(&directory).expect("create temp directory");
        let destination = directory.join("new-image.png");
        let mut registry = ImageDestinationRegistry::default();
        let receipt = registry
            .issue(destination.clone())
            .expect("issue destination");
        let (resolved, file_name) = registry.take(&receipt.ticket).expect("consume once");
        assert_eq!(
            resolved,
            directory
                .canonicalize()
                .expect("canonical temp directory")
                .join("new-image.png")
        );
        assert_eq!(file_name, "new-image.png");
        assert!(registry.take(&receipt.ticket).is_err());

        fs::write(directory.join("existing.png"), b"existing").expect("seed existing file");
        assert!(registry.issue(directory.join("existing.png")).is_err());
        fs::remove_dir_all(directory).expect("clean temp directory");
    }

    #[test]
    fn request_validation_is_protocol_and_content_based_not_model_name_based() {
        let request = GenerateImageToFileRequest {
            destination_ticket: "a".repeat(TOKEN_HEX_BYTES),
            config: ModelEndpointConfig {
                provider_id: "provider-1".to_owned(),
                provider: ProviderKind::OpenAiCompatible,
                base_url: "https://images.example/v1".to_owned(),
                authentication: AuthenticationMode::None,
                credential_header_name: None,
                model_discovery_path: None,
                text_generation_path: None,
                embedding_path: None,
                request_timeout_ms: None,
                retry_limit: None,
            },
            model: "provider-defined-image-model".to_owned(),
            prompt: "Ink painting of a moonlit library".to_owned(),
        };
        validate_request(&request).expect("verified protocol accepts provider-defined model ids");

        let unsupported = GenerateImageToFileRequest {
            config: ModelEndpointConfig {
                provider: ProviderKind::Gemini,
                ..request.config.clone()
            },
            ..request
        };
        assert!(validate_request(&unsupported).is_err());
    }
}
