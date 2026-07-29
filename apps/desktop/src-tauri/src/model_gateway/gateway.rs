use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, RequestBuilder, Response, Url};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::endpoint::ValidatedEndpoint;
use super::error::CommandError;
use super::protocol::{
    parse_ollama_embeddings, parse_ollama_models, parse_openai_embeddings, parse_openai_models,
    OllamaNdjsonParser, OpenAiSseParser, StreamItem,
};
use super::registry::{validate_generation_id, GenerationRegistry};
use super::types::{
    AuthenticationMode, CancelGenerationRequest, CancelGenerationResponse, ConnectionCheckRequest,
    ConnectionCheckResponse, EmbeddingRequest, EmbeddingResponse, GenerationAccepted,
    GenerationEvent, GenerationEventStatus, GenerationUsage, ListModelsRequest, ModelDescriptor,
    ModelEndpointConfig, ModelListResponse, ModelMessage, ProviderKind, StartGenerationRequest,
};
use crate::network_egress::RestrictedDnsResolver;

pub(crate) const NATIVE_GENERATION_EVENT: &str = "model-generation-event";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
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

pub(crate) struct ModelGatewayState {
    client: Client,
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
struct OpenAiEmbeddingBody<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Serialize)]
struct OllamaEmbeddingBody<'a> {
    model: &'a str,
    input: &'a [String],
}

struct PreparedGeneration {
    provider: ProviderKind,
    url: Url,
    authorization: Option<HeaderValue>,
    body: Vec<u8>,
}

struct PreparedEmbedding {
    provider: ProviderKind,
    endpoint_origin: String,
    url: Url,
    authorization: Option<HeaderValue>,
    body: Vec<u8>,
    model: String,
    input_count: usize,
}

enum RunOutcome {
    Completed(Option<GenerationUsage>),
    Cancelled,
}

enum ProviderStreamParser {
    OpenAi(OpenAiSseParser),
    Ollama(OllamaNdjsonParser),
}

impl ProviderStreamParser {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamItem>, CommandError> {
        match self {
            Self::OpenAi(parser) => parser.push(chunk),
            Self::Ollama(parser) => parser.push(chunk),
        }
    }

    fn finish(&mut self) -> Result<Vec<StreamItem>, CommandError> {
        match self {
            Self::OpenAi(parser) => parser.finish(),
            Self::Ollama(parser) => parser.finish(),
        }
    }
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
    embed_with_timeout(&state.client, &request, REQUEST_TIMEOUT).await
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
    let authorization = load_authorization(config).await?;
    let suffix = match config.provider {
        ProviderKind::OpenAiCompatible => "/models",
        ProviderKind::Ollama => "/api/tags",
    };
    let url = endpoint.api_url(suffix)?;
    let request = apply_authorization(
        client.get(url).header(ACCEPT, "application/json"),
        authorization,
    );
    let body = match timeout(REQUEST_TIMEOUT, fetch_limited_body(request)).await {
        Ok(result) => result?,
        Err(_) => return Err(CommandError::timeout()),
    };
    match config.provider {
        ProviderKind::OpenAiCompatible => parse_openai_models(&body),
        ProviderKind::Ollama => parse_ollama_models(&body),
    }
}

fn validate_config(config: &ModelEndpointConfig) -> Result<ValidatedEndpoint, CommandError> {
    crate::credential_account(&config.provider_id)?;
    ValidatedEndpoint::parse(config)
}

async fn load_authorization(
    config: &ModelEndpointConfig,
) -> Result<Option<HeaderValue>, CommandError> {
    if config.authentication == AuthenticationMode::None {
        return Ok(None);
    }

    let provider_id = config.provider_id.clone();
    let load = tokio::task::spawn_blocking(move || {
        let entry = crate::credential_entry(&provider_id)?;
        let password = match entry.get_password() {
            Ok(password) => Zeroizing::new(password),
            Err(keyring::Error::NoEntry) => return Err(CommandError::credential_missing()),
            Err(_) => return Err(CommandError::credential_store_unavailable()),
        };
        if password.len() < 8 || password.len() > 16_384 || password.trim().len() != password.len()
        {
            return Err(CommandError::new(
                "MODEL_CREDENTIAL_INVALID",
                "The stored model credential is invalid.",
                false,
                vec!["EDIT_API_KEY"],
            ));
        }

        let bearer = Zeroizing::new(format!("Bearer {}", password.as_str()));
        let mut value = HeaderValue::from_bytes(bearer.as_bytes()).map_err(|_| {
            CommandError::new(
                "MODEL_CREDENTIAL_INVALID",
                "The stored model credential is invalid.",
                false,
                vec!["EDIT_API_KEY"],
            )
        })?;
        value.set_sensitive(true);
        Ok(Some(value))
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
    let authorization = load_authorization(&request.config).await?;

    let (suffix, body) = match request.config.provider {
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
            ("/chat/completions", serialize_request_body(&body)?)
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
            ("/api/chat", serialize_request_body(&body)?)
        }
    };

    Ok(PreparedGeneration {
        provider: request.config.provider,
        url: endpoint.api_url(suffix)?,
        authorization,
        body,
    })
}

async fn prepare_embedding(request: &EmbeddingRequest) -> Result<PreparedEmbedding, CommandError> {
    let endpoint = validate_config(&request.config)?;
    validate_embedding_request(request)?;
    let authorization = load_authorization(&request.config).await?;
    let (suffix, body) = match request.config.provider {
        ProviderKind::OpenAiCompatible => (
            "/embeddings",
            serialize_embedding_request_body(&OpenAiEmbeddingBody {
                model: &request.model,
                input: &request.inputs,
            })?,
        ),
        ProviderKind::Ollama => (
            "/api/embed",
            serialize_embedding_request_body(&OllamaEmbeddingBody {
                model: &request.model,
                input: &request.inputs,
            })?,
        ),
    };

    Ok(PreparedEmbedding {
        provider: request.config.provider,
        endpoint_origin: endpoint.origin(),
        url: endpoint.api_url(suffix)?,
        authorization,
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
    let request = apply_authorization(
        client
            .post(prepared.url)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .body(prepared.body),
        prepared.authorization,
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

    let request = apply_authorization(
        client
            .post(prepared.url)
            .header(CONTENT_TYPE, "application/json")
            .header(
                ACCEPT,
                match prepared.provider {
                    ProviderKind::OpenAiCompatible => "text/event-stream",
                    ProviderKind::Ollama => "application/x-ndjson",
                },
            )
            .body(prepared.body),
        prepared.authorization,
    );

    let send = timeout(REQUEST_TIMEOUT, request.send());
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

fn apply_authorization(
    request: RequestBuilder,
    authorization: Option<HeaderValue>,
) -> RequestBuilder {
    match authorization {
        Some(value) => request.header(AUTHORIZATION, value),
        None => request,
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
        AuthenticationMode, EmbeddingRequest, ModelMessageRole, ProviderKind,
        StartGenerationRequest,
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
        let request = embedding_request(
            format!("{}/v1", server.base_url),
            ProviderKind::OpenAiCompatible,
            "embed-1",
            &["first private text", "second private text"],
        );
        let response = embed_with_timeout(&test_client(), &request, Duration::from_secs(2))
            .await
            .expect("embedding call should succeed");
        let wire_request = server
            .request
            .recv_timeout(Duration::from_secs(1))
            .expect("fake server should capture request");
        server.handle.join().expect("fake server should stop");
        let wire_request = String::from_utf8(wire_request).expect("request should be UTF-8");

        assert!(wire_request.starts_with("POST /v1/embeddings HTTP/1.1\r\n"));
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
        let response = apply_authorization(
            state
                .client
                .post(prepared.url)
                .header(CONTENT_TYPE, "application/json")
                .header(ACCEPT, "application/x-ndjson")
                .body(prepared.body),
            prepared.authorization,
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
