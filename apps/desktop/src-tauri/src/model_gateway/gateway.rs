use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::{HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, RequestBuilder, Response, Url};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::endpoint::ValidatedEndpoint;
use super::error::CommandError;
use super::protocol::{
    parse_anthropic_models_page, parse_gemini_embeddings, parse_gemini_models_page,
    parse_ollama_embeddings, parse_ollama_models, parse_openai_embeddings, parse_openai_models,
    parse_qwen_rerank, AnthropicSseParser, GeminiSseParser, OllamaNdjsonParser, OpenAiSseParser,
    PaginatedModels, StreamItem, MAX_MODELS,
};
use super::registry::{validate_generation_id, GenerationRegistry};
use super::types::{
    AuthenticationMode, CancelGenerationRequest, CancelGenerationResponse, ConnectionCheckRequest,
    ConnectionCheckResponse, EmbeddingRequest, EmbeddingResponse, GenerationAccepted,
    GenerationEvent, GenerationEventStatus, GenerationUsage, ListModelsRequest, ModelDescriptor,
    ModelEndpointConfig, ModelListResponse, ModelMessage, ProviderKind, RerankProtocol,
    RerankRequest, RerankResponse, StartGenerationRequest,
};
use crate::network_egress::RestrictedDnsResolver;

pub(crate) const NATIVE_GENERATION_EVENT: &str = "model-generation-event";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MIN_REQUEST_TIMEOUT_MS: u64 = 1_000;
const MAX_REQUEST_TIMEOUT_MS: u64 = 600_000;
const MAX_RETRY_LIMIT: u8 = 3;
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const GENERATION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_MODEL_LIST_BYTES: usize = 2 * 1024 * 1024;
const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_REQUEST_BYTES: usize = MAX_INPUT_BYTES + 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_EVENT_DELTA_BYTES: usize = 64 * 1024;
const MAX_MESSAGES: usize = 256;
const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_OUTPUT_TOKENS: u32 = 32_768;
const MAX_EMBEDDING_BATCH: usize = 64;
const MAX_EMBEDDING_ITEM_BYTES: usize = 64 * 1024;
const MAX_EMBEDDING_INPUT_BYTES: usize = 512 * 1024;
const MAX_EMBEDDING_REQUEST_BYTES: usize = MAX_EMBEDDING_INPUT_BYTES + 64 * 1024;
const MAX_EMBEDDING_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RERANK_DOCUMENTS: usize = 64;
const MAX_RERANK_QUERY_BYTES: usize = 16 * 1024;
const MAX_RERANK_DOCUMENT_BYTES: usize = 32 * 1024;
const MAX_RERANK_INPUT_BYTES: usize = 256 * 1024;
const MAX_RERANK_REQUEST_BYTES: usize = MAX_RERANK_INPUT_BYTES + 64 * 1024;
const MAX_RERANK_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_MODEL_LIST_PAGES: usize = 64;
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub(crate) struct ModelGatewayState {
    pub(crate) client: Client,
    registry: Arc<GenerationRegistry>,
}

impl ModelGatewayState {
    pub(crate) fn new() -> Result<Self, CommandError> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(GENERATION_TIMEOUT)
            .no_proxy()
            .dns_resolver(RestrictedDnsResolver)
            .user_agent(concat!("InkShadow/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| CommandError::connection_failed())?;
        Ok(Self {
            client,
            registry: Arc::new(GenerationRegistry::default()),
        })
    }
}

#[derive(Serialize)]
struct OpenAiGenerationBody<'a> {
    model: &'a str,
    messages: &'a [ModelMessage],
    stream: bool,
    max_tokens: u32,
    stream_options: OpenAiStreamOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Serialize)]
struct OpenAiStreamOptions {
    include_usage: bool,
}

#[derive(Serialize)]
struct OllamaGenerationOptions {
    num_predict: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Serialize)]
struct OllamaGenerationBody<'a> {
    model: &'a str,
    messages: &'a [ModelMessage],
    stream: bool,
    options: OllamaGenerationOptions,
}

#[derive(Serialize)]
struct AnthropicGenerationBody<'a> {
    model: &'a str,
    messages: Vec<AnthropicMessage<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    stream: bool,
    max_tokens: u32,
}

#[derive(Serialize)]
struct AnthropicMessage<'a> {
    role: AnthropicMessageRole,
    content: &'a str,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum AnthropicMessageRole {
    User,
    Assistant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiGenerationBody<'a> {
    contents: Vec<GeminiContent<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<GeminiContent<'a>>,
    generation_config: GeminiGenerationConfig,
}

#[derive(Serialize)]
struct GeminiContent<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<GeminiMessageRole>,
    parts: [GeminiTextPart<'a>; 1],
}

#[derive(Serialize)]
struct GeminiTextPart<'a> {
    text: Cow<'a, str>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum GeminiMessageRole {
    User,
    Model,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiGenerationConfig {
    max_output_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Serialize)]
struct OpenAiEmbeddingBody<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Serialize)]
struct OllamaEmbeddingBody<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Serialize)]
struct GeminiEmbeddingBody<'a> {
    requests: Vec<GeminiEmbeddingItem<'a>>,
}

#[derive(Serialize)]
struct GeminiEmbeddingItem<'a> {
    model: String,
    content: GeminiEmbeddingContent<'a>,
}

#[derive(Serialize)]
struct GeminiEmbeddingContent<'a> {
    parts: [GeminiTextPart<'a>; 1],
}

#[derive(Serialize)]
struct QwenRerankBody<'a> {
    model: &'a str,
    query: &'a str,
    documents: &'a [String],
    top_n: usize,
}

struct PreparedGeneration {
    provider: ProviderKind,
    url: Url,
    credential: Option<CredentialHeader>,
    body: Vec<u8>,
    request_timeout: Duration,
}

struct PreparedEmbedding {
    provider: ProviderKind,
    endpoint_origin: String,
    url: Url,
    credential: Option<CredentialHeader>,
    body: Vec<u8>,
    model: String,
    input_count: usize,
}

struct PreparedRerank {
    provider: ProviderKind,
    protocol: RerankProtocol,
    endpoint_origin: String,
    url: Url,
    credential: Option<CredentialHeader>,
    body: Vec<u8>,
    model: String,
    document_count: usize,
    top_n: usize,
}

enum RunOutcome {
    Completed(Option<GenerationUsage>),
    Cancelled,
}

enum ProviderStreamParser {
    OpenAi(OpenAiSseParser),
    Ollama(OllamaNdjsonParser),
    Anthropic(AnthropicSseParser),
    Gemini(GeminiSseParser),
}

impl ProviderStreamParser {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamItem>, CommandError> {
        match self {
            Self::OpenAi(parser) => parser.push(chunk),
            Self::Ollama(parser) => parser.push(chunk),
            Self::Anthropic(parser) => parser.push(chunk),
            Self::Gemini(parser) => parser.push(chunk),
        }
    }

    fn finish(&mut self) -> Result<Vec<StreamItem>, CommandError> {
        match self {
            Self::OpenAi(parser) => parser.finish(),
            Self::Ollama(parser) => parser.finish(),
            Self::Anthropic(parser) => parser.finish(),
            Self::Gemini(parser) => parser.finish(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct CredentialHeader {
    pub(crate) name: HeaderName,
    pub(crate) value: HeaderValue,
}

struct GenerationEmitter {
    app: AppHandle,
    generation_id: String,
    sequence: u64,
}

impl GenerationEmitter {
    fn new(app: AppHandle, generation_id: String) -> Self {
        Self {
            app,
            generation_id,
            sequence: 0,
        }
    }

    fn emit(&mut self, status: GenerationEventStatus, delta: String) -> Result<(), CommandError> {
        let event = GenerationEvent {
            generation_id: self.generation_id.clone(),
            sequence: self.sequence,
            delta,
            status,
        };
        self.app
            .emit(NATIVE_GENERATION_EVENT, event)
            .map_err(|_| CommandError::event_emit_failed())?;
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(CommandError::response_limit_exceeded)?;
        Ok(())
    }

    fn emit_delta(&mut self, delta: &str) -> Result<(), CommandError> {
        let mut start = 0;
        while start < delta.len() {
            let mut end = (start + MAX_EVENT_DELTA_BYTES).min(delta.len());
            while end > start && !delta.is_char_boundary(end) {
                end -= 1;
            }
            if end == start {
                return Err(CommandError::response_invalid());
            }
            self.emit(GenerationEventStatus::Delta, delta[start..end].to_owned())?;
            start = end;
        }
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn list_native_models(
    state: State<'_, ModelGatewayState>,
    request: ListModelsRequest,
) -> Result<ModelListResponse, CommandError> {
    let models = fetch_models(&state.client, &request.config).await?;
    Ok(ModelListResponse {
        provider: request.config.provider,
        models,
    })
}

#[tauri::command]
pub(crate) async fn check_native_model_connection(
    state: State<'_, ModelGatewayState>,
    request: ConnectionCheckRequest,
) -> Result<ConnectionCheckResponse, CommandError> {
    let endpoint = validate_config(&request.config)?;
    let started = Instant::now();
    let models = fetch_models_with_endpoint(&state.client, &request.config, &endpoint).await?;
    Ok(ConnectionCheckResponse {
        provider: request.config.provider,
        endpoint_origin: endpoint.origin(),
        model_count: models.len(),
        latency_ms: started.elapsed().as_millis(),
    })
}

#[tauri::command]
pub(crate) async fn embed_native_model(
    state: State<'_, ModelGatewayState>,
    request: EmbeddingRequest,
) -> Result<EmbeddingResponse, CommandError> {
    let request_timeout = configured_request_timeout(&request.config)?;
    embed_with_timeout(&state.client, &request, request_timeout).await
}

#[tauri::command]
pub(crate) async fn rerank_native_model(
    state: State<'_, ModelGatewayState>,
    request: RerankRequest,
) -> Result<RerankResponse, CommandError> {
    let request_timeout = configured_request_timeout(&request.config)?;
    rerank_with_timeout(&state.client, &request, request_timeout).await
}

#[tauri::command]
pub(crate) async fn start_native_generation(
    app: AppHandle,
    state: State<'_, ModelGatewayState>,
    request: StartGenerationRequest,
) -> Result<GenerationAccepted, CommandError> {
    validate_generation_id(&request.generation_id)?;
    let prepared = prepare_generation(&request).await?;
    let generation_id = request.generation_id.clone();
    let cancellation = state.registry.register(&generation_id)?;
    let registry = Arc::clone(&state.registry);
    let client = state.client.clone();
    let mut emitter = GenerationEmitter::new(app, generation_id.clone());
    if let Err(error) = emitter.emit(GenerationEventStatus::Started, String::new()) {
        let _ = registry.remove(&generation_id);
        return Err(error);
    }

    tauri::async_runtime::spawn(async move {
        drive_generation(
            client,
            prepared,
            cancellation,
            registry,
            generation_id,
            emitter,
        )
        .await;
    });

    Ok(GenerationAccepted {
        generation_id: request.generation_id,
        accepted: true,
    })
}

#[tauri::command]
pub(crate) fn cancel_native_generation(
    state: State<'_, ModelGatewayState>,
    request: CancelGenerationRequest,
) -> Result<CancelGenerationResponse, CommandError> {
    let cancellation_requested = state.registry.cancel(&request.generation_id)?;
    Ok(CancelGenerationResponse {
        generation_id: request.generation_id,
        cancellation_requested,
    })
}

async fn fetch_models(
    client: &Client,
    config: &ModelEndpointConfig,
) -> Result<Vec<ModelDescriptor>, CommandError> {
    let endpoint = validate_config(config)?;
    fetch_models_with_endpoint(client, config, &endpoint).await
}

async fn fetch_models_with_endpoint(
    client: &Client,
    config: &ModelEndpointConfig,
    endpoint: &ValidatedEndpoint,
) -> Result<Vec<ModelDescriptor>, CommandError> {
    let credential = load_credential(config).await?;
    let request_timeout = configured_request_timeout(config)?;
    let retry_limit = configured_retry_limit(config)?;
    match config.provider {
        ProviderKind::OpenAiCompatible => {
            let body = fetch_model_page(
                client,
                endpoint.api_url(config.model_discovery_path.as_deref().unwrap_or("/models"))?,
                config.provider,
                credential,
                request_timeout,
                retry_limit,
            )
            .await?;
            parse_openai_models(&body)
        }
        ProviderKind::Ollama => {
            let body = fetch_model_page(
                client,
                endpoint.api_url("/api/tags")?,
                config.provider,
                credential,
                request_timeout,
                retry_limit,
            )
            .await?;
            parse_ollama_models(&body)
        }
        ProviderKind::Anthropic => {
            fetch_paginated_models(
                client,
                config.provider,
                credential,
                request_timeout,
                retry_limit,
                |cursor| {
                    let mut url = endpoint.api_url("/models")?;
                    {
                        let mut query = url.query_pairs_mut();
                        query.append_pair("limit", "1000");
                        if let Some(cursor) = cursor {
                            query.append_pair("after_id", cursor);
                        }
                    }
                    Ok(url)
                },
                parse_anthropic_models_page,
            )
            .await
        }
        ProviderKind::Gemini => {
            fetch_paginated_models(
                client,
                config.provider,
                credential,
                request_timeout,
                retry_limit,
                |cursor| {
                    let mut url = endpoint.api_url("/models")?;
                    {
                        let mut query = url.query_pairs_mut();
                        query.append_pair("pageSize", "1000");
                        if let Some(cursor) = cursor {
                            query.append_pair("pageToken", cursor);
                        }
                    }
                    Ok(url)
                },
                parse_gemini_models_page,
            )
            .await
        }
    }
}

async fn fetch_model_page(
    client: &Client,
    url: Url,
    provider: ProviderKind,
    credential: Option<CredentialHeader>,
    request_timeout: Duration,
    retry_limit: u8,
) -> Result<Vec<u8>, CommandError> {
    for attempt in 0..=retry_limit {
        let request = apply_provider_headers(
            client.get(url.clone()).header(ACCEPT, "application/json"),
            provider,
            credential.clone(),
        );
        let result = match timeout(request_timeout, fetch_limited_body(request)).await {
            Ok(result) => result,
            Err(_) => Err(CommandError::timeout()),
        };
        match result {
            Ok(body) => return Ok(body),
            Err(error) if attempt < retry_limit && error.retryable() => continue,
            Err(error) => return Err(error),
        }
    }
    Err(CommandError::runtime_failed())
}

async fn fetch_paginated_models(
    client: &Client,
    provider: ProviderKind,
    credential: Option<CredentialHeader>,
    request_timeout: Duration,
    retry_limit: u8,
    make_url: impl Fn(Option<&str>) -> Result<Url, CommandError>,
    parse_page: fn(&[u8]) -> Result<PaginatedModels, CommandError>,
) -> Result<Vec<ModelDescriptor>, CommandError> {
    let mut models = Vec::new();
    let mut seen_models = HashSet::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor: Option<String> = None;

    for _ in 0..MAX_MODEL_LIST_PAGES {
        let body = fetch_model_page(
            client,
            make_url(cursor.as_deref())?,
            provider,
            credential.clone(),
            request_timeout,
            retry_limit,
        )
        .await?;
        let page = parse_page(&body)?;
        for model in page.models {
            if seen_models.insert(model.id.clone()) {
                models.push(model);
                if models.len() > MAX_MODELS {
                    return Err(CommandError::response_limit_exceeded());
                }
            }
        }
        let Some(next_cursor) = page.next_cursor else {
            return Ok(models);
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(CommandError::response_invalid());
        }
        cursor = Some(next_cursor);
    }
    Err(CommandError::response_limit_exceeded())
}

pub(crate) fn validate_config(
    config: &ModelEndpointConfig,
) -> Result<ValidatedEndpoint, CommandError> {
    crate::credential_account(&config.provider_id)?;
    let endpoint = ValidatedEndpoint::parse(config)?;
    configured_request_timeout(config)?;
    configured_retry_limit(config)?;

    let has_custom_path = config.model_discovery_path.is_some()
        || config.text_generation_path.is_some()
        || config.embedding_path.is_some();
    if config.provider != ProviderKind::OpenAiCompatible
        && (has_custom_path
            || config.credential_header_name.is_some()
            || config.authentication == AuthenticationMode::CustomHeaderKeyring)
    {
        return Err(CommandError::endpoint_invalid());
    }
    for path in [
        config.model_discovery_path.as_deref(),
        config.text_generation_path.as_deref(),
        config.embedding_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        endpoint.api_url(path)?;
    }
    match config.authentication {
        AuthenticationMode::CustomHeaderKeyring => {
            let name = config
                .credential_header_name
                .as_deref()
                .ok_or_else(CommandError::endpoint_invalid)?;
            validate_credential_header_name(name)?;
        }
        AuthenticationMode::None | AuthenticationMode::BearerKeyring => {
            if config.credential_header_name.is_some() {
                return Err(CommandError::endpoint_invalid());
            }
        }
    }
    Ok(endpoint)
}

pub(crate) fn configured_request_timeout(
    config: &ModelEndpointConfig,
) -> Result<Duration, CommandError> {
    let milliseconds = config
        .request_timeout_ms
        .unwrap_or(REQUEST_TIMEOUT.as_millis() as u64);
    if !(MIN_REQUEST_TIMEOUT_MS..=MAX_REQUEST_TIMEOUT_MS).contains(&milliseconds) {
        return Err(CommandError::request_invalid());
    }
    Ok(Duration::from_millis(milliseconds))
}

fn configured_retry_limit(config: &ModelEndpointConfig) -> Result<u8, CommandError> {
    let retry_limit = config.retry_limit.unwrap_or(0);
    if retry_limit > MAX_RETRY_LIMIT {
        return Err(CommandError::request_invalid());
    }
    Ok(retry_limit)
}

fn validate_credential_header_name(value: &str) -> Result<HeaderName, CommandError> {
    if value.is_empty() || value.len() > 128 || value.trim() != value {
        return Err(CommandError::endpoint_invalid());
    }
    let name =
        HeaderName::from_bytes(value.as_bytes()).map_err(|_| CommandError::endpoint_invalid())?;
    let normalized = name.as_str();
    if matches!(
        normalized,
        "accept"
            | "accept-encoding"
            | "connection"
            | "content-encoding"
            | "content-length"
            | "content-type"
            | "cookie"
            | "expect"
            | "forwarded"
            | "host"
            | "keep-alive"
            | "origin"
            | "proxy-authorization"
            | "proxy-connection"
            | "referer"
            | "set-cookie"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "user-agent"
            | "via"
    ) || normalized.starts_with("proxy-")
        || normalized.starts_with("sec-")
        || normalized.starts_with("x-forwarded-")
    {
        return Err(CommandError::endpoint_invalid());
    }
    Ok(name)
}

pub(crate) async fn load_credential(
    config: &ModelEndpointConfig,
) -> Result<Option<CredentialHeader>, CommandError> {
    if config.authentication == AuthenticationMode::None {
        return Ok(None);
    }

    let provider_id = config.provider_id.clone();
    let provider = config.provider;
    let authentication = config.authentication;
    let custom_header_name = match authentication {
        AuthenticationMode::CustomHeaderKeyring => Some(validate_credential_header_name(
            config
                .credential_header_name
                .as_deref()
                .ok_or_else(CommandError::endpoint_invalid)?,
        )?),
        AuthenticationMode::None | AuthenticationMode::BearerKeyring => None,
    };
    let load = tokio::task::spawn_blocking(move || {
        let entry = crate::credential_entry(&provider_id)?;
        let password = match entry.get_password() {
            Ok(password) => Zeroizing::new(password),
            Err(keyring::Error::NoEntry) => return Err(CommandError::credential_missing()),
            Err(_) => return Err(CommandError::credential_store_unavailable()),
        };
        if password.len() < 8
            || password.len() > 16_384
            || password.trim().len() != password.len()
            || !password.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        {
            return Err(CommandError::new(
                "MODEL_CREDENTIAL_INVALID",
                "The stored model credential is invalid.",
                false,
                vec!["EDIT_API_KEY"],
            ));
        }

        let header_name = match authentication {
            AuthenticationMode::CustomHeaderKeyring => {
                custom_header_name.ok_or_else(CommandError::endpoint_invalid)?
            }
            AuthenticationMode::BearerKeyring => match provider {
                ProviderKind::OpenAiCompatible | ProviderKind::Ollama => AUTHORIZATION,
                ProviderKind::Anthropic => HeaderName::from_static("x-api-key"),
                ProviderKind::Gemini => HeaderName::from_static("x-goog-api-key"),
            },
            AuthenticationMode::None => return Ok(None),
        };
        let wire_value = match authentication {
            AuthenticationMode::CustomHeaderKeyring => Zeroizing::new(password.as_str().to_owned()),
            AuthenticationMode::BearerKeyring => match provider {
                ProviderKind::OpenAiCompatible | ProviderKind::Ollama => {
                    Zeroizing::new(format!("Bearer {}", password.as_str()))
                }
                ProviderKind::Anthropic | ProviderKind::Gemini => {
                    Zeroizing::new(password.as_str().to_owned())
                }
            },
            AuthenticationMode::None => return Ok(None),
        };
        let mut value = HeaderValue::from_bytes(wire_value.as_bytes()).map_err(|_| {
            CommandError::new(
                "MODEL_CREDENTIAL_INVALID",
                "The stored model credential is invalid.",
                false,
                vec!["EDIT_API_KEY"],
            )
        })?;
        value.set_sensitive(true);
        Ok(Some(CredentialHeader {
            name: header_name,
            value,
        }))
    });
    match timeout(REQUEST_TIMEOUT, load).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(CommandError::runtime_failed()),
        Err(_) => Err(CommandError::timeout()),
    }
}

async fn prepare_generation(
    request: &StartGenerationRequest,
) -> Result<PreparedGeneration, CommandError> {
    let endpoint = validate_config(&request.config)?;
    validate_generation_request(request)?;
    let credential = load_credential(&request.config).await?;
    let request_timeout = configured_request_timeout(&request.config)?;

    let (url, body) = match request.config.provider {
        ProviderKind::OpenAiCompatible => {
            let body = OpenAiGenerationBody {
                model: &request.model,
                messages: &request.messages,
                stream: true,
                max_tokens: request.max_output_tokens,
                stream_options: OpenAiStreamOptions {
                    include_usage: true,
                },
                temperature: request.temperature,
            };
            (
                endpoint.api_url(
                    request
                        .config
                        .text_generation_path
                        .as_deref()
                        .unwrap_or("/chat/completions"),
                )?,
                serialize_request_body(&body)?,
            )
        }
        ProviderKind::Ollama => {
            let body = OllamaGenerationBody {
                model: &request.model,
                messages: &request.messages,
                stream: true,
                options: OllamaGenerationOptions {
                    num_predict: request.max_output_tokens,
                    temperature: request.temperature,
                },
            };
            (
                endpoint.api_url("/api/chat")?,
                serialize_request_body(&body)?,
            )
        }
        ProviderKind::Anthropic => {
            if request
                .temperature
                .is_some_and(|temperature| temperature != 1.0)
            {
                return Err(CommandError::operation_unsupported());
            }
            let body = build_anthropic_generation_body(request)?;
            (
                endpoint.api_url("/messages")?,
                serialize_request_body(&body)?,
            )
        }
        ProviderKind::Gemini => {
            let body = build_gemini_generation_body(request)?;
            let model = normalized_gemini_model_name(&request.model)?;
            let mut url = endpoint.api_url(&format!("/models/{model}:streamGenerateContent"))?;
            url.query_pairs_mut().append_pair("alt", "sse");
            (url, serialize_request_body(&body)?)
        }
    };

    Ok(PreparedGeneration {
        provider: request.config.provider,
        url,
        credential,
        body,
        request_timeout,
    })
}

fn build_anthropic_generation_body(
    request: &StartGenerationRequest,
) -> Result<AnthropicGenerationBody<'_>, CommandError> {
    let mut messages = Vec::new();
    let mut system_parts = Vec::new();
    let mut saw_conversation_message = false;
    for message in &request.messages {
        match message.role {
            super::types::ModelMessageRole::System => {
                if saw_conversation_message {
                    return Err(CommandError::request_invalid());
                }
                system_parts.push(message.content.as_str());
            }
            super::types::ModelMessageRole::User => {
                saw_conversation_message = true;
                messages.push(AnthropicMessage {
                    role: AnthropicMessageRole::User,
                    content: &message.content,
                });
            }
            super::types::ModelMessageRole::Assistant => {
                saw_conversation_message = true;
                messages.push(AnthropicMessage {
                    role: AnthropicMessageRole::Assistant,
                    content: &message.content,
                });
            }
        }
    }
    if messages.is_empty() {
        return Err(CommandError::request_invalid());
    }
    Ok(AnthropicGenerationBody {
        model: &request.model,
        messages,
        system: (!system_parts.is_empty()).then(|| system_parts.join("\n\n")),
        stream: true,
        max_tokens: request.max_output_tokens,
    })
}

fn build_gemini_generation_body(
    request: &StartGenerationRequest,
) -> Result<GeminiGenerationBody<'_>, CommandError> {
    let mut contents = Vec::new();
    let mut system_parts = Vec::new();
    let mut saw_conversation_message = false;
    for message in &request.messages {
        match message.role {
            super::types::ModelMessageRole::System => {
                if saw_conversation_message {
                    return Err(CommandError::request_invalid());
                }
                system_parts.push(message.content.as_str());
            }
            super::types::ModelMessageRole::User => {
                saw_conversation_message = true;
                contents.push(GeminiContent {
                    role: Some(GeminiMessageRole::User),
                    parts: [GeminiTextPart {
                        text: Cow::Borrowed(&message.content),
                    }],
                });
            }
            super::types::ModelMessageRole::Assistant => {
                saw_conversation_message = true;
                contents.push(GeminiContent {
                    role: Some(GeminiMessageRole::Model),
                    parts: [GeminiTextPart {
                        text: Cow::Borrowed(&message.content),
                    }],
                });
            }
        }
    }
    if contents.is_empty() {
        return Err(CommandError::request_invalid());
    }
    let system_instruction = (!system_parts.is_empty()).then(|| GeminiContent {
        role: None,
        parts: [GeminiTextPart {
            text: Cow::Owned(system_parts.join("\n\n")),
        }],
    });
    Ok(GeminiGenerationBody {
        contents,
        system_instruction,
        generation_config: GeminiGenerationConfig {
            max_output_tokens: request.max_output_tokens,
            temperature: request.temperature,
        },
    })
}

fn normalized_gemini_model_name(model: &str) -> Result<&str, CommandError> {
    let model = model.strip_prefix("models/").unwrap_or(model);
    if model.is_empty()
        || model.len() > MAX_MODEL_ID_BYTES
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(CommandError::request_invalid());
    }
    Ok(model)
}

async fn prepare_embedding(request: &EmbeddingRequest) -> Result<PreparedEmbedding, CommandError> {
    let endpoint = validate_config(&request.config)?;
    validate_embedding_request(request)?;
    if request.config.provider == ProviderKind::Anthropic {
        return Err(CommandError::operation_unsupported());
    }
    let credential = load_credential(&request.config).await?;
    let (url, body) = match request.config.provider {
        ProviderKind::OpenAiCompatible => (
            endpoint.api_url(
                request
                    .config
                    .embedding_path
                    .as_deref()
                    .unwrap_or("/embeddings"),
            )?,
            serialize_embedding_request_body(&OpenAiEmbeddingBody {
                model: &request.model,
                input: &request.inputs,
            })?,
        ),
        ProviderKind::Ollama => (
            endpoint.api_url("/api/embed")?,
            serialize_embedding_request_body(&OllamaEmbeddingBody {
                model: &request.model,
                input: &request.inputs,
            })?,
        ),
        ProviderKind::Gemini => {
            let model_name = normalized_gemini_model_name(&request.model)?;
            let model_resource = format!("models/{model_name}");
            let body = GeminiEmbeddingBody {
                requests: request
                    .inputs
                    .iter()
                    .map(|input| GeminiEmbeddingItem {
                        model: model_resource.clone(),
                        content: GeminiEmbeddingContent {
                            parts: [GeminiTextPart {
                                text: Cow::Borrowed(input),
                            }],
                        },
                    })
                    .collect(),
            };
            (
                endpoint.api_url(&format!("/models/{model_name}:batchEmbedContents"))?,
                serialize_embedding_request_body(&body)?,
            )
        }
        ProviderKind::Anthropic => unreachable!("handled before credential loading"),
    };

    Ok(PreparedEmbedding {
        provider: request.config.provider,
        endpoint_origin: endpoint.origin(),
        url,
        credential,
        body,
        model: request.model.clone(),
        input_count: request.inputs.len(),
    })
}

fn validate_embedding_request(request: &EmbeddingRequest) -> Result<(), CommandError> {
    if request.model.is_empty()
        || request.model.len() > MAX_MODEL_ID_BYTES
        || request.model.trim() != request.model
        || request.model.chars().any(char::is_control)
        || request.inputs.is_empty()
        || request.inputs.len() > MAX_EMBEDDING_BATCH
    {
        return Err(CommandError::request_invalid());
    }

    let mut total_bytes = 0usize;
    for input in &request.inputs {
        if input.is_empty()
            || input.len() > MAX_EMBEDDING_ITEM_BYTES
            || input
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        {
            return Err(CommandError::request_invalid());
        }
        total_bytes = total_bytes
            .checked_add(input.len())
            .ok_or_else(CommandError::input_limit_exceeded)?;
        if total_bytes > MAX_EMBEDDING_INPUT_BYTES {
            return Err(CommandError::input_limit_exceeded());
        }
    }
    Ok(())
}

fn serialize_embedding_request_body(value: &impl Serialize) -> Result<Vec<u8>, CommandError> {
    let body = serde_json::to_vec(value).map_err(|_| CommandError::request_invalid())?;
    if body.len() > MAX_EMBEDDING_REQUEST_BYTES {
        return Err(CommandError::input_limit_exceeded());
    }
    Ok(body)
}

async fn embed_with_timeout(
    client: &Client,
    request: &EmbeddingRequest,
    request_timeout: Duration,
) -> Result<EmbeddingResponse, CommandError> {
    let prepared = prepare_embedding(request).await?;
    match timeout(request_timeout, execute_embedding(client, prepared)).await {
        Ok(result) => result,
        Err(_) => Err(CommandError::timeout()),
    }
}

async fn execute_embedding(
    client: &Client,
    prepared: PreparedEmbedding,
) -> Result<EmbeddingResponse, CommandError> {
    let request = apply_provider_headers(
        client
            .post(prepared.url)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .body(prepared.body),
        prepared.provider,
        prepared.credential,
    );
    let response = request
        .send()
        .await
        .map_err(|error| CommandError::from_reqwest(&error))?;
    assert_success_status(&response)?;
    let body = collect_limited_body(response, MAX_EMBEDDING_RESPONSE_BYTES).await?;
    let embeddings = match prepared.provider {
        ProviderKind::OpenAiCompatible => {
            parse_openai_embeddings(&body, &prepared.model, prepared.input_count)?
        }
        ProviderKind::Ollama => {
            parse_ollama_embeddings(&body, &prepared.model, prepared.input_count)?
        }
        ProviderKind::Gemini => parse_gemini_embeddings(&body, prepared.input_count)?,
        ProviderKind::Anthropic => return Err(CommandError::operation_unsupported()),
    };
    let dimension = embeddings
        .first()
        .map(Vec::len)
        .ok_or_else(CommandError::response_invalid)?;
    Ok(EmbeddingResponse {
        provider: prepared.provider,
        endpoint_origin: prepared.endpoint_origin,
        model: prepared.model,
        dimension,
        vector_count: embeddings.len(),
        embeddings,
    })
}

async fn prepare_rerank(request: &RerankRequest) -> Result<PreparedRerank, CommandError> {
    let endpoint = validate_config(&request.config)?;
    validate_rerank_request(request)?;
    if request.config.provider != ProviderKind::OpenAiCompatible
        || request.protocol != RerankProtocol::QwenOpenAiCompatible
    {
        return Err(CommandError::operation_unsupported());
    }
    if request.config.authentication != AuthenticationMode::BearerKeyring {
        return Err(CommandError::credential_missing());
    }
    let credential = load_credential(&request.config).await?;
    let body = serde_json::to_vec(&QwenRerankBody {
        model: &request.model,
        query: &request.query,
        documents: &request.documents,
        top_n: request.top_n,
    })
    .map_err(|_| CommandError::request_invalid())?;
    if body.len() > MAX_RERANK_REQUEST_BYTES {
        return Err(CommandError::input_limit_exceeded());
    }

    Ok(PreparedRerank {
        provider: request.config.provider,
        protocol: request.protocol,
        endpoint_origin: endpoint.origin(),
        url: endpoint.api_url("/reranks")?,
        credential,
        body,
        model: request.model.clone(),
        document_count: request.documents.len(),
        top_n: request.top_n,
    })
}

fn validate_rerank_request(request: &RerankRequest) -> Result<(), CommandError> {
    if request.model.is_empty()
        || request.model.len() > MAX_MODEL_ID_BYTES
        || request.model.trim() != request.model
        || request.model.chars().any(char::is_control)
        || request.query.is_empty()
        || request.query.len() > MAX_RERANK_QUERY_BYTES
        || contains_unsupported_control_character(&request.query)
        || request.documents.is_empty()
        || request.documents.len() > MAX_RERANK_DOCUMENTS
        || request.top_n == 0
        || request.top_n > request.documents.len()
    {
        return Err(CommandError::request_invalid());
    }

    let mut total_bytes = request.query.len();
    for document in &request.documents {
        if document.is_empty()
            || document.len() > MAX_RERANK_DOCUMENT_BYTES
            || contains_unsupported_control_character(document)
        {
            return Err(CommandError::request_invalid());
        }
        total_bytes = total_bytes
            .checked_add(document.len())
            .ok_or_else(CommandError::input_limit_exceeded)?;
        if total_bytes > MAX_RERANK_INPUT_BYTES {
            return Err(CommandError::input_limit_exceeded());
        }
    }
    Ok(())
}

fn contains_unsupported_control_character(value: &str) -> bool {
    value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

async fn rerank_with_timeout(
    client: &Client,
    request: &RerankRequest,
    request_timeout: Duration,
) -> Result<RerankResponse, CommandError> {
    let prepared = prepare_rerank(request).await?;
    match timeout(request_timeout, execute_rerank(client, prepared)).await {
        Ok(result) => result,
        Err(_) => Err(CommandError::timeout()),
    }
}

async fn execute_rerank(
    client: &Client,
    prepared: PreparedRerank,
) -> Result<RerankResponse, CommandError> {
    let request = apply_provider_headers(
        client
            .post(prepared.url)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .body(prepared.body),
        prepared.provider,
        prepared.credential,
    );
    let response = request
        .send()
        .await
        .map_err(|error| CommandError::from_reqwest(&error))?;
    assert_success_status(&response)?;
    let body = collect_limited_body(response, MAX_RERANK_RESPONSE_BYTES).await?;
    let (rankings, input_tokens) = parse_qwen_rerank(
        &body,
        &prepared.model,
        prepared.document_count,
        prepared.top_n,
    )?;
    Ok(RerankResponse {
        provider: prepared.provider,
        protocol: prepared.protocol,
        endpoint_origin: prepared.endpoint_origin,
        model: prepared.model,
        rankings,
        input_tokens,
    })
}

fn validate_generation_request(request: &StartGenerationRequest) -> Result<(), CommandError> {
    if request.model.is_empty()
        || request.model.len() > MAX_MODEL_ID_BYTES
        || request.model.trim() != request.model
        || request.model.chars().any(char::is_control)
        || request.messages.is_empty()
        || request.messages.len() > MAX_MESSAGES
        || !(1..=MAX_OUTPUT_TOKENS).contains(&request.max_output_tokens)
        || request.temperature.is_some_and(|temperature| {
            !temperature.is_finite() || !(0.0..=2.0).contains(&temperature)
        })
    {
        return Err(CommandError::request_invalid());
    }

    let mut input_bytes = 0usize;
    for message in &request.messages {
        if message.content.is_empty()
            || message
                .content
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        {
            return Err(CommandError::request_invalid());
        }
        input_bytes = input_bytes
            .checked_add(message.content.len())
            .ok_or_else(CommandError::input_limit_exceeded)?;
        if input_bytes > MAX_INPUT_BYTES {
            return Err(CommandError::input_limit_exceeded());
        }
    }
    Ok(())
}

fn serialize_request_body(value: &impl Serialize) -> Result<Vec<u8>, CommandError> {
    let body = serde_json::to_vec(value).map_err(|_| CommandError::request_invalid())?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err(CommandError::input_limit_exceeded());
    }
    Ok(body)
}

async fn drive_generation(
    client: Client,
    prepared: PreparedGeneration,
    cancellation: CancellationToken,
    registry: Arc<GenerationRegistry>,
    generation_id: String,
    mut emitter: GenerationEmitter,
) {
    let result = timeout(
        GENERATION_TIMEOUT,
        stream_generation(&client, prepared, &cancellation, &mut emitter),
    )
    .await;

    let status = match result {
        Ok(Ok(RunOutcome::Completed(usage))) => GenerationEventStatus::Completed { usage },
        Ok(Ok(RunOutcome::Cancelled)) => GenerationEventStatus::Cancelled,
        Ok(Err(error)) => GenerationEventStatus::Failed {
            code: error.code(),
            retryable: error.retryable(),
        },
        Err(_) => GenerationEventStatus::Failed {
            code: "MODEL_TIMEOUT",
            retryable: true,
        },
    };
    let _ = emitter.emit(status, String::new());
    let _ = registry.remove(&generation_id);
}

async fn stream_generation(
    client: &Client,
    prepared: PreparedGeneration,
    cancellation: &CancellationToken,
    emitter: &mut GenerationEmitter,
) -> Result<RunOutcome, CommandError> {
    if cancellation.is_cancelled() {
        return Ok(RunOutcome::Cancelled);
    }

    let request = apply_provider_headers(
        client
            .post(prepared.url)
            .header(CONTENT_TYPE, "application/json")
            .header(
                ACCEPT,
                match prepared.provider {
                    ProviderKind::OpenAiCompatible => "text/event-stream",
                    ProviderKind::Ollama => "application/x-ndjson",
                    ProviderKind::Anthropic | ProviderKind::Gemini => "text/event-stream",
                },
            )
            .body(prepared.body),
        prepared.provider,
        prepared.credential,
    );

    let send = timeout(prepared.request_timeout, request.send());
    let mut response = tokio::select! {
        _ = cancellation.cancelled() => return Ok(RunOutcome::Cancelled),
        result = send => {
            match result {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => return Err(CommandError::from_reqwest(&error)),
                Err(_) => return Err(CommandError::timeout()),
            }
        }
    };
    assert_success_status(&response)?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(CommandError::response_limit_exceeded());
    }

    let mut parser = match prepared.provider {
        ProviderKind::OpenAiCompatible => ProviderStreamParser::OpenAi(OpenAiSseParser::default()),
        ProviderKind::Ollama => ProviderStreamParser::Ollama(OllamaNdjsonParser::default()),
        ProviderKind::Anthropic => ProviderStreamParser::Anthropic(AnthropicSseParser::default()),
        ProviderKind::Gemini => ProviderStreamParser::Gemini(GeminiSseParser::default()),
    };
    let mut response_bytes = 0usize;
    let mut output_bytes = 0usize;
    let mut usage: Option<GenerationUsage> = None;

    loop {
        let next_chunk = timeout(STREAM_IDLE_TIMEOUT, response.chunk());
        let chunk = tokio::select! {
            _ = cancellation.cancelled() => return Ok(RunOutcome::Cancelled),
            result = next_chunk => {
                match result {
                    Ok(Ok(chunk)) => chunk,
                    Ok(Err(error)) => return Err(CommandError::from_reqwest(&error)),
                    Err(_) => return Err(CommandError::timeout()),
                }
            }
        };

        let Some(chunk) = chunk else {
            let items = parser.finish()?;
            if process_stream_items(items, &mut output_bytes, &mut usage, emitter)? {
                return Ok(RunOutcome::Completed(usage));
            }
            return Err(CommandError::stream_truncated());
        };

        response_bytes = response_bytes
            .checked_add(chunk.len())
            .ok_or_else(CommandError::response_limit_exceeded)?;
        if response_bytes > MAX_RESPONSE_BYTES {
            return Err(CommandError::response_limit_exceeded());
        }
        let items = parser.push(&chunk)?;
        if process_stream_items(items, &mut output_bytes, &mut usage, emitter)? {
            return Ok(RunOutcome::Completed(usage));
        }
    }
}

fn process_stream_items(
    items: Vec<StreamItem>,
    output_bytes: &mut usize,
    usage: &mut Option<GenerationUsage>,
    emitter: &mut GenerationEmitter,
) -> Result<bool, CommandError> {
    for item in items {
        match item {
            StreamItem::Delta(delta) => {
                *output_bytes = output_bytes
                    .checked_add(delta.len())
                    .ok_or_else(CommandError::output_limit_exceeded)?;
                if *output_bytes > MAX_OUTPUT_BYTES {
                    return Err(CommandError::output_limit_exceeded());
                }
                emitter.emit_delta(&delta)?;
            }
            StreamItem::Usage(next) => {
                if usage.as_ref().is_some_and(|current| current != &next) {
                    return Err(CommandError::response_invalid());
                }
                *usage = Some(next);
            }
            StreamItem::Done => return Ok(true),
        }
    }
    Ok(false)
}

fn apply_provider_headers(
    request: RequestBuilder,
    provider: ProviderKind,
    credential: Option<CredentialHeader>,
) -> RequestBuilder {
    let request = match credential {
        Some(credential) => request.header(credential.name, credential.value),
        None => request,
    };
    if provider == ProviderKind::Anthropic {
        request.header("anthropic-version", ANTHROPIC_VERSION)
    } else {
        request
    }
}

async fn fetch_limited_body(request: RequestBuilder) -> Result<Vec<u8>, CommandError> {
    let response = request
        .send()
        .await
        .map_err(|error| CommandError::from_reqwest(&error))?;
    assert_success_status(&response)?;
    collect_limited_body(response, MAX_MODEL_LIST_BYTES).await
}

fn assert_success_status(response: &Response) -> Result<(), CommandError> {
    if response.status().is_success() {
        Ok(())
    } else {
        Err(CommandError::from_http_status(response.status()))
    }
}

async fn collect_limited_body(
    mut response: Response,
    maximum_bytes: usize,
) -> Result<Vec<u8>, CommandError> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(CommandError::response_limit_exceeded());
    }

    let mut body = Vec::new();
    loop {
        let chunk = match timeout(STREAM_IDLE_TIMEOUT, response.chunk()).await {
            Ok(Ok(chunk)) => chunk,
            Ok(Err(error)) => return Err(CommandError::from_reqwest(&error)),
            Err(_) => return Err(CommandError::timeout()),
        };
        let Some(chunk) = chunk else {
            return Ok(body);
        };
        if body.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(CommandError::response_limit_exceeded());
        }
        body.extend_from_slice(&chunk);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_gateway::types::{
        AuthenticationMode, EmbeddingRequest, ModelMessageRole, ProviderKind, RerankProtocol,
        RerankRequest, StartGenerationRequest,
    };
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{self, Receiver};
    use std::thread::{self, JoinHandle};

    struct FakeServer {
        base_url: String,
        request: Receiver<Vec<u8>>,
        handle: JoinHandle<()>,
    }

    fn spawn_fake_server(
        status: &str,
        body: &[u8],
        delay: Duration,
        declared_length: Option<usize>,
    ) -> FakeServer {
        let listener =
            TcpListener::bind("127.0.0.1:0").expect("fake model server should bind loopback");
        let address = listener
            .local_addr()
            .expect("fake model server should have an address");
        let (request_tx, request_rx) = mpsc::sync_channel(1);
        let status = status.to_owned();
        let body = body.to_vec();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("fake server should accept");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("read timeout should apply");
            let request = read_http_request(&mut stream);
            let _ = request_tx.send(request);
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                declared_length.unwrap_or(body.len())
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(&body);
        });
        FakeServer {
            base_url: format!("http://{address}"),
            request: request_rx,
            handle,
        }
    }

    fn spawn_sequence_server(responses: &[(&str, &[u8])]) -> FakeServer {
        let listener =
            TcpListener::bind("127.0.0.1:0").expect("fake model server should bind loopback");
        let address = listener
            .local_addr()
            .expect("fake model server should have an address");
        let (request_tx, request_rx) = mpsc::sync_channel(responses.len());
        let responses = responses
            .iter()
            .map(|(status, body)| ((*status).to_owned(), (*body).to_vec()))
            .collect::<Vec<_>>();
        let handle = thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().expect("fake server should accept");
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .expect("read timeout should apply");
                let _ = request_tx.send(read_http_request(&mut stream));
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        FakeServer {
            base_url: format!("http://{address}"),
            request: request_rx,
            handle,
        }
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0u8; 4_096];
        while let Ok(read) = stream.read(&mut buffer) {
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            let Some(headers_end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n")
            else {
                continue;
            };
            let headers_end = headers_end + 4;
            let headers = String::from_utf8_lossy(&request[..headers_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if request.len() >= headers_end.saturating_add(content_length) {
                break;
            }
        }
        request
    }

    fn test_client() -> Client {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .expect("test client should build")
    }

    fn embedding_request(
        base_url: String,
        provider: ProviderKind,
        model: &str,
        inputs: &[&str],
    ) -> EmbeddingRequest {
        EmbeddingRequest {
            config: ModelEndpointConfig {
                provider_id: "embedding-test".to_owned(),
                provider,
                base_url,
                authentication: AuthenticationMode::None,
                credential_header_name: None,
                model_discovery_path: None,
                text_generation_path: None,
                embedding_path: None,
                request_timeout_ms: None,
                retry_limit: None,
            },
            model: model.to_owned(),
            inputs: inputs.iter().map(|input| (*input).to_owned()).collect(),
        }
    }

    fn generation_request() -> StartGenerationRequest {
        StartGenerationRequest {
            generation_id: "generation-1".to_owned(),
            config: ModelEndpointConfig {
                provider_id: "provider-1".to_owned(),
                provider: ProviderKind::OpenAiCompatible,
                base_url: "https://models.example/v1".to_owned(),
                authentication: AuthenticationMode::None,
                credential_header_name: None,
                model_discovery_path: None,
                text_generation_path: None,
                embedding_path: None,
                request_timeout_ms: None,
                retry_limit: None,
            },
            model: "model-1".to_owned(),
            messages: vec![ModelMessage {
                role: ModelMessageRole::User,
                content: "Write a safe candidate.".to_owned(),
            }],
            max_output_tokens: 1_024,
            temperature: Some(0.7),
        }
    }

    fn rerank_request(base_url: String) -> RerankRequest {
        RerankRequest {
            config: ModelEndpointConfig {
                provider_id: "qwen-rerank-test".to_owned(),
                provider: ProviderKind::OpenAiCompatible,
                base_url,
                authentication: AuthenticationMode::BearerKeyring,
                credential_header_name: None,
                model_discovery_path: None,
                text_generation_path: None,
                embedding_path: None,
                request_timeout_ms: None,
                retry_limit: None,
            },
            protocol: RerankProtocol::QwenOpenAiCompatible,
            model: "qwen3-rerank".to_owned(),
            query: "Which source continues the scene?".to_owned(),
            documents: vec!["first source".to_owned(), "second source".to_owned()],
            top_n: 2,
        }
    }

    #[test]
    fn validates_generation_limits_without_network_access() {
        assert!(validate_generation_request(&generation_request()).is_ok());

        let mut empty_messages = generation_request();
        empty_messages.messages.clear();
        assert!(validate_generation_request(&empty_messages).is_err());

        let mut oversized = generation_request();
        oversized.messages[0].content = "x".repeat(MAX_INPUT_BYTES + 1);
        assert!(validate_generation_request(&oversized).is_err());

        let mut invalid_temperature = generation_request();
        invalid_temperature.temperature = Some(f32::NAN);
        assert!(validate_generation_request(&invalid_temperature).is_err());
    }

    #[test]
    fn validates_custom_header_timeout_and_provider_override_boundaries() {
        let mut custom = generation_request().config;
        custom.authentication = AuthenticationMode::CustomHeaderKeyring;
        custom.credential_header_name = Some("Authorization".to_owned());
        custom.model_discovery_path = Some("/custom/models".to_owned());
        custom.text_generation_path = Some("/custom/chat".to_owned());
        custom.embedding_path = Some("/custom/embed".to_owned());
        custom.request_timeout_ms = Some(47_000);
        custom.retry_limit = Some(3);
        assert!(validate_config(&custom).is_ok());
        assert_eq!(
            configured_request_timeout(&custom).expect("valid timeout"),
            Duration::from_secs(47)
        );
        assert_eq!(configured_retry_limit(&custom).expect("valid retries"), 3);

        for name in [
            "Host",
            "Cookie",
            "Content-Length",
            "Connection",
            "Transfer-Encoding",
            "Proxy-Authorization",
            "Sec-Fetch-Site",
            "X-Forwarded-Host",
            "bad header",
        ] {
            custom.credential_header_name = Some(name.to_owned());
            assert!(validate_config(&custom).is_err(), "{name} must be rejected");
        }

        custom.credential_header_name = Some("x-api-key".to_owned());
        custom.provider = ProviderKind::Anthropic;
        assert!(validate_config(&custom).is_err());
        custom.provider = ProviderKind::OpenAiCompatible;
        custom.request_timeout_ms = Some(999);
        assert!(validate_config(&custom).is_err());
        custom.request_timeout_ms = Some(47_000);
        custom.retry_limit = Some(4);
        assert!(validate_config(&custom).is_err());
    }

    #[tokio::test]
    async fn uses_custom_text_path_without_applying_generation_retries() {
        let mut request = generation_request();
        request.config.text_generation_path = Some("/custom/text/generate".to_owned());
        request.config.request_timeout_ms = Some(12_000);
        request.config.retry_limit = Some(3);
        let prepared = prepare_generation(&request)
            .await
            .expect("custom text request should prepare");
        assert_eq!(
            prepared.url.as_str(),
            "https://models.example/v1/custom/text/generate"
        );
        assert_eq!(prepared.request_timeout, Duration::from_secs(12));
        // retry_limit is intentionally absent from PreparedGeneration: POST
        // dispatch can be billable and must never be repeated ambiguously.
    }

    #[tokio::test]
    async fn retries_only_idempotent_custom_model_discovery_gets() {
        let server = spawn_sequence_server(&[
            ("500 Internal Server Error", br#"{"error":"temporary"}"#),
            ("200 OK", br#"{"data":[{"id":"writer-model"}]}"#),
        ]);
        let mut config = generation_request().config;
        config.base_url = format!("{}/v1", server.base_url);
        config.model_discovery_path = Some("/custom/catalog".to_owned());
        config.request_timeout_ms = Some(2_000);
        config.retry_limit = Some(1);

        let models = fetch_models(&test_client(), &config)
            .await
            .expect("one safe retry should recover model discovery");
        let first = String::from_utf8(
            server
                .request
                .recv_timeout(Duration::from_secs(1))
                .expect("first request"),
        )
        .expect("request should be UTF-8");
        let second = String::from_utf8(
            server
                .request
                .recv_timeout(Duration::from_secs(1))
                .expect("retried request"),
        )
        .expect("request should be UTF-8");
        server.handle.join().expect("fake server should stop");

        assert_eq!(models[0].id, "writer-model");
        assert!(first.starts_with("GET /v1/custom/catalog HTTP/1.1\r\n"));
        assert!(second.starts_with("GET /v1/custom/catalog HTTP/1.1\r\n"));
    }

    #[test]
    fn serializes_provider_specific_requests_with_hard_output_limits() {
        let request = generation_request();
        let openai = OpenAiGenerationBody {
            model: &request.model,
            messages: &request.messages,
            stream: true,
            max_tokens: request.max_output_tokens,
            stream_options: OpenAiStreamOptions {
                include_usage: true,
            },
            temperature: request.temperature,
        };
        let body = serialize_request_body(&openai).expect("request should serialize");
        let value: serde_json::Value =
            serde_json::from_slice(&body).expect("serialized request should be JSON");

        assert_eq!(value["stream"], true);
        assert_eq!(value["stream_options"]["include_usage"], true);
        assert_eq!(value["max_tokens"], 1_024);
        assert_eq!(value["messages"][0]["role"], "user");
        assert_eq!(value["messages"][0]["content"], "Write a safe candidate.");

        let mut provider_request = generation_request();
        provider_request.temperature = None;
        provider_request.messages = vec![
            ModelMessage {
                role: ModelMessageRole::System,
                content: "Keep the prose concise.".to_owned(),
            },
            ModelMessage {
                role: ModelMessageRole::User,
                content: "Continue the scene.".to_owned(),
            },
            ModelMessage {
                role: ModelMessageRole::Assistant,
                content: "The door opened.".to_owned(),
            },
        ];

        let anthropic = build_anthropic_generation_body(&provider_request)
            .expect("Anthropic request should be expressible");
        let value = serde_json::to_value(anthropic).expect("Anthropic body should serialize");
        assert_eq!(value["system"], "Keep the prose concise.");
        assert_eq!(value["messages"][0]["role"], "user");
        assert_eq!(value["messages"][1]["role"], "assistant");
        assert_eq!(value["stream"], true);
        assert_eq!(value["max_tokens"], 1_024);
        assert!(value.get("temperature").is_none());

        let gemini = build_gemini_generation_body(&provider_request)
            .expect("Gemini request should be expressible");
        let value = serde_json::to_value(gemini).expect("Gemini body should serialize");
        assert_eq!(
            value["systemInstruction"]["parts"][0]["text"],
            "Keep the prose concise."
        );
        assert_eq!(value["contents"][0]["role"], "user");
        assert_eq!(value["contents"][1]["role"], "model");
        assert_eq!(value["generationConfig"]["maxOutputTokens"], 1_024);

        provider_request.messages.swap(0, 1);
        assert!(build_anthropic_generation_body(&provider_request).is_err());
        assert!(build_gemini_generation_body(&provider_request).is_err());
    }

    #[tokio::test]
    async fn prepares_real_anthropic_and_gemini_stream_endpoints() {
        let mut anthropic = generation_request();
        anthropic.config.provider = ProviderKind::Anthropic;
        anthropic.config.base_url = "https://api.anthropic.com/v1".to_owned();
        anthropic.model = "claude-example".to_owned();
        anthropic.temperature = None;
        let prepared = prepare_generation(&anthropic)
            .await
            .expect("Anthropic generation should prepare");
        assert_eq!(
            prepared.url.as_str(),
            "https://api.anthropic.com/v1/messages"
        );
        assert!(matches!(prepared.provider, ProviderKind::Anthropic));

        anthropic.temperature = Some(0.7);
        assert_eq!(
            prepare_generation(&anthropic)
                .await
                .err()
                .expect("deprecated Claude sampling parameters must not be sent silently")
                .code(),
            "MODEL_OPERATION_UNSUPPORTED"
        );

        let mut gemini = generation_request();
        gemini.config.provider = ProviderKind::Gemini;
        gemini.config.base_url = "https://generativelanguage.googleapis.com/v1beta".to_owned();
        gemini.model = "models/gemini-example".to_owned();
        let prepared = prepare_generation(&gemini)
            .await
            .expect("Gemini generation should prepare");
        assert_eq!(
            prepared.url.as_str(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-example:streamGenerateContent?alt=sse"
        );
        assert!(matches!(prepared.provider, ProviderKind::Gemini));

        gemini.model = "models/../unsafe".to_owned();
        assert_eq!(
            prepare_generation(&gemini)
                .await
                .err()
                .expect("path-like model identifiers must be rejected")
                .code(),
            "MODEL_REQUEST_INVALID"
        );
    }

    #[tokio::test]
    async fn discovers_anthropic_and_gemini_models_using_official_routes() {
        let anthropic_server = spawn_fake_server(
            "200 OK",
            br#"{"data":[{"id":"claude-example","display_name":"Claude Example"}],"has_more":false}"#,
            Duration::ZERO,
            None,
        );
        let anthropic_config = ModelEndpointConfig {
            provider_id: "anthropic-test".to_owned(),
            provider: ProviderKind::Anthropic,
            base_url: format!("{}/v1", anthropic_server.base_url),
            authentication: AuthenticationMode::None,
            credential_header_name: None,
            model_discovery_path: None,
            text_generation_path: None,
            embedding_path: None,
            request_timeout_ms: None,
            retry_limit: None,
        };
        let models = fetch_models(&test_client(), &anthropic_config)
            .await
            .expect("Anthropic model discovery should succeed");
        assert_eq!(models[0].display_name, "Claude Example");
        let wire_request = String::from_utf8(
            anthropic_server
                .request
                .recv_timeout(Duration::from_secs(1))
                .expect("capture Anthropic request"),
        )
        .expect("request should be UTF-8");
        anthropic_server
            .handle
            .join()
            .expect("Anthropic server should stop");
        assert!(wire_request.starts_with("GET /v1/models?limit=1000 HTTP/1.1\r\n"));
        assert!(wire_request
            .to_ascii_lowercase()
            .contains("anthropic-version: 2023-06-01\r\n"));

        let gemini_server = spawn_fake_server(
            "200 OK",
            br#"{"models":[{"name":"models/gemini-example","displayName":"Gemini Example"}]}"#,
            Duration::ZERO,
            None,
        );
        let gemini_config = ModelEndpointConfig {
            provider_id: "gemini-test".to_owned(),
            provider: ProviderKind::Gemini,
            base_url: format!("{}/v1beta", gemini_server.base_url),
            authentication: AuthenticationMode::None,
            credential_header_name: None,
            model_discovery_path: None,
            text_generation_path: None,
            embedding_path: None,
            request_timeout_ms: None,
            retry_limit: None,
        };
        let models = fetch_models(&test_client(), &gemini_config)
            .await
            .expect("Gemini model discovery should succeed");
        assert_eq!(models[0].display_name, "Gemini Example");
        let wire_request = String::from_utf8(
            gemini_server
                .request
                .recv_timeout(Duration::from_secs(1))
                .expect("capture Gemini request"),
        )
        .expect("request should be UTF-8");
        gemini_server
            .handle
            .join()
            .expect("Gemini server should stop");
        assert!(wire_request.starts_with("GET /v1beta/models?pageSize=1000 HTTP/1.1\r\n"));
    }

    #[test]
    fn applies_sensitive_provider_specific_credentials() {
        for (provider, header_name) in [
            (ProviderKind::Anthropic, "x-api-key"),
            (ProviderKind::Gemini, "x-goog-api-key"),
        ] {
            let mut value = HeaderValue::from_static("test-secret-value");
            value.set_sensitive(true);
            let request = apply_provider_headers(
                test_client().get("https://models.example/v1/models"),
                provider,
                Some(CredentialHeader {
                    name: HeaderName::from_static(header_name),
                    value,
                }),
            )
            .build()
            .expect("request should build");
            assert_eq!(request.headers()[header_name], "test-secret-value");
            assert!(!format!("{request:?}").contains("test-secret-value"));
        }
    }

    #[tokio::test]
    async fn rejects_unsupported_provider_embeddings_without_network_access() {
        let request = embedding_request(
            "http://localhost:11434".to_owned(),
            ProviderKind::Anthropic,
            "embedding-model",
            &["private text"],
        );
        assert_eq!(
            prepare_embedding(&request)
                .await
                .err()
                .expect("unsupported embeddings must fail before network access")
                .code(),
            "MODEL_OPERATION_UNSUPPORTED"
        );
    }

    #[tokio::test]
    async fn calls_openai_embedding_endpoint_and_preserves_index_order() {
        let server = spawn_fake_server(
            "200 OK",
            br#"{
                "data":[
                    {"index":1,"embedding":[0.3,0.4]},
                    {"index":0,"embedding":[0.1,0.2]}
                ],
                "model":"embed-1"
            }"#,
            Duration::ZERO,
            None,
        );
        let mut request = embedding_request(
            format!("{}/v1", server.base_url),
            ProviderKind::OpenAiCompatible,
            "embed-1",
            &["first private text", "second private text"],
        );
        request.config.embedding_path = Some("/custom/vectors".to_owned());
        request.config.request_timeout_ms = Some(2_000);
        request.config.retry_limit = Some(3);
        let response = embed_with_timeout(&test_client(), &request, Duration::from_secs(2))
            .await
            .expect("embedding call should succeed");
        let wire_request = server
            .request
            .recv_timeout(Duration::from_secs(1))
            .expect("fake server should capture request");
        server.handle.join().expect("fake server should stop");
        let wire_request = String::from_utf8(wire_request).expect("request should be UTF-8");

        assert!(wire_request.starts_with("POST /v1/custom/vectors HTTP/1.1\r\n"));
        let body = wire_request
            .split_once("\r\n\r\n")
            .expect("request should have a body")
            .1;
        let body: serde_json::Value =
            serde_json::from_str(body).expect("embedding request should be JSON");
        assert_eq!(body["model"], "embed-1");
        assert_eq!(body["input"][0], "first private text");
        assert_eq!(response.endpoint_origin, server.base_url);
        assert_eq!(response.dimension, 2);
        assert_eq!(response.vector_count, 2);
        assert_eq!(response.embeddings[0], vec![0.1, 0.2]);
    }

    #[tokio::test]
    async fn calls_ollama_embed_endpoint_without_provider_guessing() {
        let server = spawn_fake_server(
            "200 OK",
            br#"{"model":"nomic-embed-text","embeddings":[[0.1,0.2,0.3]]}"#,
            Duration::ZERO,
            None,
        );
        let request = embedding_request(
            server.base_url.clone(),
            ProviderKind::Ollama,
            "nomic-embed-text",
            &["local source"],
        );
        let response = embed_with_timeout(&test_client(), &request, Duration::from_secs(2))
            .await
            .expect("Ollama embedding call should succeed");
        let wire_request = String::from_utf8(
            server
                .request
                .recv_timeout(Duration::from_secs(1))
                .expect("fake server should capture request"),
        )
        .expect("request should be UTF-8");
        server.handle.join().expect("fake server should stop");

        assert!(wire_request.starts_with("POST /api/embed HTTP/1.1\r\n"));
        assert_eq!(response.provider, ProviderKind::Ollama);
        assert_eq!(response.dimension, 3);
    }

    #[tokio::test]
    async fn calls_gemini_batch_embedding_endpoint_in_input_order() {
        let server = spawn_fake_server(
            "200 OK",
            br#"{"embeddings":[{"values":[0.1,0.2]},{"values":[0.3,0.4]}]}"#,
            Duration::ZERO,
            None,
        );
        let request = embedding_request(
            format!("{}/v1beta", server.base_url),
            ProviderKind::Gemini,
            "models/gemini-embedding-example",
            &["first private text", "second private text"],
        );
        let response = embed_with_timeout(&test_client(), &request, Duration::from_secs(2))
            .await
            .expect("Gemini batch embedding should succeed");
        let wire_request = String::from_utf8(
            server
                .request
                .recv_timeout(Duration::from_secs(1))
                .expect("fake server should capture request"),
        )
        .expect("request should be UTF-8");
        server.handle.join().expect("fake server should stop");

        assert!(wire_request.starts_with(
            "POST /v1beta/models/gemini-embedding-example:batchEmbedContents HTTP/1.1\r\n"
        ));
        let body = wire_request
            .split_once("\r\n\r\n")
            .expect("request should have a body")
            .1;
        let body: serde_json::Value =
            serde_json::from_str(body).expect("Gemini embedding request should be JSON");
        assert_eq!(
            body["requests"][0]["model"],
            "models/gemini-embedding-example"
        );
        assert_eq!(
            body["requests"][1]["content"]["parts"][0]["text"],
            "second private text"
        );
        assert_eq!(response.provider, ProviderKind::Gemini);
        assert_eq!(response.dimension, 2);
        assert_eq!(response.embeddings[1], vec![0.3, 0.4]);
    }

    #[tokio::test]
    async fn rejects_malformed_huge_and_timed_out_embedding_responses_safely() {
        let malformed = spawn_fake_server(
            "200 OK",
            br#"{"model":"embed-1","data":[
                {"index":0,"embedding":[0.1,0.2]},
                {"index":1,"embedding":[0.3]}
            ],"providerSecret":"must-not-escape"}"#,
            Duration::ZERO,
            None,
        );
        let malformed_request = embedding_request(
            malformed.base_url.clone(),
            ProviderKind::OpenAiCompatible,
            "embed-1",
            &["one", "two"],
        );
        let error = embed_with_timeout(&test_client(), &malformed_request, Duration::from_secs(2))
            .await
            .expect_err("dimension mismatch should fail");
        malformed.handle.join().expect("fake server should stop");
        assert_eq!(error.code(), "MODEL_RESPONSE_INVALID");
        assert!(!serde_json::to_string(&error)
            .expect("error should serialize")
            .contains("must-not-escape"));

        let huge = spawn_fake_server(
            "200 OK",
            b"{}",
            Duration::ZERO,
            Some(MAX_EMBEDDING_RESPONSE_BYTES + 1),
        );
        let huge_request = embedding_request(
            huge.base_url.clone(),
            ProviderKind::OpenAiCompatible,
            "embed-1",
            &["one"],
        );
        let error = embed_with_timeout(&test_client(), &huge_request, Duration::from_secs(2))
            .await
            .expect_err("oversized declared response should fail");
        huge.handle.join().expect("fake server should stop");
        assert_eq!(error.code(), "MODEL_RESPONSE_LIMIT_EXCEEDED");

        let slow = spawn_fake_server(
            "200 OK",
            br#"{"model":"embed-1","data":[{"index":0,"embedding":[0.1]}]}"#,
            Duration::from_millis(150),
            None,
        );
        let slow_request = embedding_request(
            slow.base_url.clone(),
            ProviderKind::OpenAiCompatible,
            "embed-1",
            &["one"],
        );
        let error = embed_with_timeout(&test_client(), &slow_request, Duration::from_millis(20))
            .await
            .expect_err("slow response should time out");
        slow.handle.join().expect("fake server should stop");
        assert_eq!(error.code(), "MODEL_TIMEOUT");
    }

    #[test]
    fn enforces_embedding_batch_item_total_and_model_limits_before_network() {
        let valid = embedding_request(
            "http://localhost:11434".to_owned(),
            ProviderKind::Ollama,
            "embed-1",
            &["one"],
        );
        assert!(validate_embedding_request(&valid).is_ok());

        let mut no_inputs = valid.clone();
        no_inputs.inputs.clear();
        assert_eq!(
            validate_embedding_request(&no_inputs)
                .expect_err("empty batch should fail")
                .code(),
            "MODEL_REQUEST_INVALID"
        );

        let mut too_many = valid.clone();
        too_many.inputs = vec!["x".to_owned(); MAX_EMBEDDING_BATCH + 1];
        assert!(validate_embedding_request(&too_many).is_err());

        let mut oversized_item = valid.clone();
        oversized_item.inputs = vec!["x".repeat(MAX_EMBEDDING_ITEM_BYTES + 1)];
        assert!(validate_embedding_request(&oversized_item).is_err());

        let mut oversized_total = valid.clone();
        oversized_total.inputs = vec!["x".repeat(MAX_EMBEDDING_ITEM_BYTES); MAX_EMBEDDING_BATCH];
        assert_eq!(
            validate_embedding_request(&oversized_total)
                .expect_err("oversized total should fail")
                .code(),
            "MODEL_INPUT_LIMIT_EXCEEDED"
        );

        let mut invalid_model = valid;
        invalid_model.model = " embed-1".to_owned();
        assert!(validate_embedding_request(&invalid_model).is_err());
    }

    #[tokio::test]
    async fn calls_only_the_explicit_qwen_rerank_protocol_with_bounded_output() {
        let server = spawn_fake_server(
            "200 OK",
            br#"{"object":"list","results":[{"index":1,"relevance_score":0.91}],"model":"qwen3-rerank","id":"request-id","usage":{"total_tokens":41}}"#,
            Duration::ZERO,
            None,
        );
        let request = rerank_request(format!("{}/compatible-api/v1", server.base_url));
        let prepared = PreparedRerank {
            provider: ProviderKind::OpenAiCompatible,
            protocol: RerankProtocol::QwenOpenAiCompatible,
            endpoint_origin: server.base_url.clone(),
            url: Url::parse(&format!("{}/compatible-api/v1/reranks", server.base_url))
                .expect("test URL should parse"),
            credential: None,
            body: serde_json::to_vec(&QwenRerankBody {
                model: &request.model,
                query: &request.query,
                documents: &request.documents,
                top_n: request.top_n,
            })
            .expect("test request should serialize"),
            model: request.model.clone(),
            document_count: request.documents.len(),
            top_n: request.top_n,
        };
        let response = timeout(
            Duration::from_secs(2),
            execute_rerank(&test_client(), prepared),
        )
        .await
        .expect("test server should respond before timeout")
        .expect("Qwen rerank request should succeed");
        let wire_request = String::from_utf8(
            server
                .request
                .recv_timeout(Duration::from_secs(1))
                .expect("fake server should capture request"),
        )
        .expect("request should be UTF-8");
        server.handle.join().expect("fake server should stop");

        assert!(wire_request.starts_with("POST /compatible-api/v1/reranks HTTP/1.1\r\n"));
        let body: serde_json::Value = serde_json::from_str(
            wire_request
                .split_once("\r\n\r\n")
                .expect("request should contain a body")
                .1,
        )
        .expect("rerank body should be JSON");
        assert_eq!(body["model"], "qwen3-rerank");
        assert_eq!(body["query"], "Which source continues the scene?");
        assert_eq!(body["documents"].as_array().map(Vec::len), Some(2));
        assert_eq!(body["top_n"], 2);
        assert_eq!(response.rankings[0].index, 1);
        assert_eq!(response.input_tokens, Some(41));
        let safe_response = serde_json::to_string(&response).expect("response should serialize");
        assert!(!safe_response.contains("first source"));
        assert!(!safe_response.contains("Which source"));
    }

    #[tokio::test]
    async fn enforces_rerank_protocol_and_input_limits_before_network_access() {
        let valid = rerank_request(
            "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-api/v1".to_owned(),
        );
        assert!(validate_rerank_request(&valid).is_ok());

        let mut unsupported = valid.clone();
        unsupported.config.provider = ProviderKind::Gemini;
        assert_eq!(
            prepare_rerank(&unsupported)
                .await
                .err()
                .expect("Gemini must not be treated as supporting rerank")
                .code(),
            "MODEL_OPERATION_UNSUPPORTED"
        );

        let mut no_keyring = valid.clone();
        no_keyring.config.authentication = AuthenticationMode::None;
        assert_eq!(
            prepare_rerank(&no_keyring)
                .await
                .err()
                .expect("remote rerank must use the OS credential store")
                .code(),
            "MODEL_CREDENTIAL_MISSING"
        );

        let mut duplicate_safe_limit = valid.clone();
        duplicate_safe_limit.documents = vec!["x".to_owned(); MAX_RERANK_DOCUMENTS + 1];
        assert!(validate_rerank_request(&duplicate_safe_limit).is_err());

        let mut oversized_query = valid.clone();
        oversized_query.query = "x".repeat(MAX_RERANK_QUERY_BYTES + 1);
        assert!(validate_rerank_request(&oversized_query).is_err());

        let mut invalid_top_n = valid;
        invalid_top_n.top_n = invalid_top_n.documents.len() + 1;
        assert!(validate_rerank_request(&invalid_top_n).is_err());
    }

    #[tokio::test]
    #[ignore = "requires an explicitly configured local Ollama installation and models"]
    async fn exercises_real_local_ollama_discovery_embedding_and_generation() {
        let base_url = std::env::var("INKSHADOW_TEST_OLLAMA_URL")
            .expect("INKSHADOW_TEST_OLLAMA_URL must explicitly opt in");
        let generation_model = std::env::var("INKSHADOW_TEST_OLLAMA_GENERATION_MODEL")
            .expect("INKSHADOW_TEST_OLLAMA_GENERATION_MODEL must explicitly opt in");
        let embedding_model = std::env::var("INKSHADOW_TEST_OLLAMA_EMBEDDING_MODEL")
            .expect("INKSHADOW_TEST_OLLAMA_EMBEDDING_MODEL must explicitly opt in");
        let state = ModelGatewayState::new().expect("build the production-restricted HTTP client");
        let config = ModelEndpointConfig {
            provider_id: "real-local-ollama".to_owned(),
            provider: ProviderKind::Ollama,
            base_url,
            authentication: AuthenticationMode::None,
            credential_header_name: None,
            model_discovery_path: None,
            text_generation_path: None,
            embedding_path: None,
            request_timeout_ms: None,
            retry_limit: None,
        };

        let models = fetch_models(&state.client, &config)
            .await
            .expect("discover real local Ollama models");
        let generation_descriptor = models
            .iter()
            .find(|model| model.id == generation_model)
            .expect("generation model should be installed");
        assert!(generation_descriptor.size_bytes.unwrap_or_default() > 0);
        let embedding_descriptor = models
            .iter()
            .find(|model| model.id == embedding_model)
            .expect("embedding model should be installed");
        assert!(embedding_descriptor.size_bytes.unwrap_or_default() > 0);

        let embedding = embed_with_timeout(
            &state.client,
            &EmbeddingRequest {
                config: config.clone(),
                model: embedding_model.clone(),
                inputs: vec![
                    "雾港的钟声在午夜响起。".to_owned(),
                    "The lighthouse keeper found a sealed letter.".to_owned(),
                ],
            },
            REQUEST_TIMEOUT,
        )
        .await
        .expect("generate real local embeddings");
        assert_eq!(embedding.provider, ProviderKind::Ollama);
        assert_eq!(embedding.model, embedding_model);
        assert_eq!(embedding.vector_count, 2);
        assert!(embedding.dimension >= 64);
        assert!(embedding
            .embeddings
            .iter()
            .flatten()
            .all(|value| value.is_finite()));

        let prepared = prepare_generation(&StartGenerationRequest {
            generation_id: "real-local-ollama-generation".to_owned(),
            config,
            model: generation_model,
            messages: vec![
                ModelMessage {
                    role: ModelMessageRole::System,
                    content: "Reply with one short plain-text sentence. Do not use Markdown."
                        .to_owned(),
                },
                ModelMessage {
                    role: ModelMessageRole::User,
                    content: "Write a six-word sentence about a lighthouse.".to_owned(),
                },
            ],
            max_output_tokens: 32,
            temperature: Some(0.0),
        })
        .await
        .expect("prepare the real local generation request");
        assert!(matches!(prepared.provider, ProviderKind::Ollama));
        let response = apply_provider_headers(
            state
                .client
                .post(prepared.url)
                .header(CONTENT_TYPE, "application/json")
                .header(ACCEPT, "application/x-ndjson")
                .body(prepared.body),
            prepared.provider,
            prepared.credential,
        )
        .send()
        .await
        .expect("stream from real local Ollama");
        assert_success_status(&response).expect("real local Ollama should accept generation");
        let mut response = response;
        let mut parser = ProviderStreamParser::Ollama(OllamaNdjsonParser::default());
        let mut output = String::new();
        let mut usage = None;
        let mut done = false;
        let mut response_bytes = 0usize;
        while let Some(chunk) = timeout(STREAM_IDLE_TIMEOUT, response.chunk())
            .await
            .expect("real local Ollama stream should not stall")
            .expect("real local Ollama stream should remain readable")
        {
            response_bytes = response_bytes
                .checked_add(chunk.len())
                .expect("response byte counter should not overflow");
            assert!(response_bytes <= MAX_RESPONSE_BYTES);
            for item in parser.push(&chunk).expect("parse real Ollama NDJSON") {
                match item {
                    StreamItem::Delta(delta) => output.push_str(&delta),
                    StreamItem::Usage(next) => usage = Some(next),
                    StreamItem::Done => done = true,
                }
            }
        }
        for item in parser.finish().expect("finish real Ollama NDJSON") {
            match item {
                StreamItem::Delta(delta) => output.push_str(&delta),
                StreamItem::Usage(next) => usage = Some(next),
                StreamItem::Done => done = true,
            }
        }
        assert!(done);
        assert!(!output.trim().is_empty());
        assert!(output.len() <= MAX_OUTPUT_BYTES);
        assert!(usage.is_some());
    }
}
