use std::borrow::Cow;
use std::collections::HashSet;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use reqwest::header::{HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, RequestBuilder, Response, Url};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::endpoint::ValidatedEndpoint;
use super::error::CommandError;
use super::protocol::{
    parse_anthropic_models_page, parse_gemini_embeddings, parse_gemini_models_page,
    parse_ollama_embeddings, parse_ollama_models, parse_openai_embeddings, parse_openai_models,
    parse_qwen_rerank, AnthropicSseParser, GeminiSseParser, OllamaNdjsonParser,
    OpenAiResponseParser, PaginatedModels, StreamItem, MAX_MODELS,
};
use super::registry::{validate_generation_id, ActiveDispatchRegistry, GenerationRegistry};
use super::types::{
    AuthenticationMode, CancelGenerationRequest, CancelGenerationResponse, ConnectionCheckRequest,
    ConnectionCheckResponse, EmbeddingRequest, EmbeddingResponse, GenerationAccepted,
    GenerationEvent, GenerationEventStatus, GenerationUsage, ListModelsRequest, ModelDescriptor,
    ModelEndpointConfig, ModelListResponse, ModelMessage, ProviderKind, ReasoningMode,
    RerankProtocol, RerankRequest, RerankResponse, ResponseFormat, StartGenerationRequest,
};
use crate::native_sqlite::{
    valid_model_invocation_dispatch_task, ModelInvocationDispatchLedgerError,
    NativeModelDispatchScope, NativeModelInvocationDispatchLedger,
    NativeModelInvocationDispatchReceipt, NativeModelInvocationDispatchTarget, NativeSqliteState,
    ProjectRemoteDispatchLease, ProjectRemoteDispatchLeaseError,
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

#[derive(Clone)]
pub(crate) struct ModelGatewayState {
    pub(crate) client: Client,
    registry: Arc<GenerationRegistry>,
    dispatch_registry: Arc<ActiveDispatchRegistry>,
    dispatch_lifecycle: Arc<AsyncMutex<()>>,
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
            dispatch_registry: Arc::new(ActiveDispatchRegistry::default()),
            dispatch_lifecycle: Arc::new(AsyncMutex::new(())),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<OpenAiThinking>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<OpenAiResponseFormat>,
}

#[derive(Serialize)]
struct OpenAiStreamOptions {
    include_usage: bool,
}

#[derive(Serialize)]
struct OpenAiThinking {
    #[serde(rename = "type")]
    mode: ReasoningMode,
}

#[derive(Serialize)]
struct OpenAiResponseFormat {
    #[serde(rename = "type")]
    format: ResponseFormat,
}

#[derive(Serialize)]
struct OllamaGenerationOptions {
    num_predict: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
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
    endpoint_is_loopback: bool,
}

struct PreparedEmbedding {
    provider: ProviderKind,
    endpoint_origin: String,
    url: Url,
    credential: Option<CredentialHeader>,
    body: Vec<u8>,
    model: String,
    input_count: usize,
    endpoint_is_loopback: bool,
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
    endpoint_is_loopback: bool,
}

enum RunOutcome {
    Completed {
        usage: Option<GenerationUsage>,
        streamed: bool,
    },
    Cancelled,
}

#[derive(Default)]
struct GenerationObservation {
    http_status: Option<u16>,
    finish_reason: Option<String>,
    reasoning_present: Option<bool>,
    reasoning_length: Option<u64>,
    stream: Option<bool>,
    usage: Option<GenerationUsage>,
}

impl GenerationObservation {
    fn attach(&self, mut error: CommandError) -> CommandError {
        if error.http_status().is_none() {
            if let Some(status) = self.http_status {
                error = error.with_http_status(status);
            }
        }
        error.with_generation_observation(
            self.finish_reason.clone(),
            self.reasoning_present,
            self.reasoning_length,
            self.stream,
            self.usage.clone(),
        )
    }
}

enum ProviderStreamParser {
    OpenAi(OpenAiResponseParser),
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

    fn streamed(&self) -> Option<bool> {
        match self {
            Self::OpenAi(parser) => parser.streamed(),
            Self::Ollama(_) | Self::Anthropic(_) | Self::Gemini(_) => Some(true),
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

trait GenerationDeltaSink {
    fn emit_delta(&mut self, delta: &str) -> Result<(), CommandError>;
}

trait GenerationEventSink: GenerationDeltaSink + Send {
    fn emit_status(
        &mut self,
        status: GenerationEventStatus,
        delta: String,
    ) -> Result<(), CommandError>;
}

struct NativeGenerationLifecycle<Emitter> {
    state: ModelGatewayState,
    sqlite: NativeSqliteState,
    prepared: PreparedGeneration,
    cancellation: CancellationToken,
    generation_id: String,
    emitter: Emitter,
    lease: Option<ProjectRemoteDispatchLease>,
}

impl GenerationDeltaSink for GenerationEmitter {
    fn emit_delta(&mut self, delta: &str) -> Result<(), CommandError> {
        GenerationEmitter::emit_delta(self, delta)
    }
}

impl GenerationEventSink for GenerationEmitter {
    fn emit_status(
        &mut self,
        status: GenerationEventStatus,
        delta: String,
    ) -> Result<(), CommandError> {
        self.emit(status, delta)
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
    sqlite: State<'_, NativeSqliteState>,
    request: EmbeddingRequest,
) -> Result<EmbeddingResponse, CommandError> {
    embed_native_model_inner(&state, &sqlite, request).await
}

async fn embed_native_model_inner(
    state: &ModelGatewayState,
    sqlite: &NativeSqliteState,
    request: EmbeddingRequest,
) -> Result<EmbeddingResponse, CommandError> {
    validate_embedding_invocation_dispatch_ledger_request(&request)?;
    let request_timeout = configured_request_timeout(&request.config)?;
    let prepared = prepare_embedding(&request).await?;
    let invocation_dispatch_boundary = request
        .invocation_dispatch_ledger
        .as_ref()
        .map(|ledger| {
            Ok::<_, CommandError>((
                ledger.clone(),
                embedding_invocation_dispatch_target(&request)?,
            ))
        })
        .transpose()?;
    let operation_id = request.invocation_dispatch_ledger.as_ref().map_or_else(
        || uuid::Uuid::now_v7().to_string(),
        |ledger| ledger.invocation_id.clone(),
    );
    run_prepared_embedding_with_dispatch_and_ledger(
        state,
        sqlite,
        &request.dispatch_scope,
        request_timeout,
        prepared,
        operation_id,
        invocation_dispatch_boundary,
    )
    .await
}

#[cfg(test)]
async fn run_prepared_embedding_with_dispatch(
    state: &ModelGatewayState,
    sqlite: &NativeSqliteState,
    dispatch_scope: &NativeModelDispatchScope,
    request_timeout: Duration,
    prepared: PreparedEmbedding,
    operation_id: String,
) -> Result<EmbeddingResponse, CommandError> {
    run_prepared_embedding_with_dispatch_and_ledger(
        state,
        sqlite,
        dispatch_scope,
        request_timeout,
        prepared,
        operation_id,
        None,
    )
    .await
}

async fn run_prepared_embedding_with_dispatch_and_ledger(
    state: &ModelGatewayState,
    sqlite: &NativeSqliteState,
    dispatch_scope: &NativeModelDispatchScope,
    request_timeout: Duration,
    prepared: PreparedEmbedding,
    operation_id: String,
    invocation_dispatch_boundary: Option<(
        NativeModelInvocationDispatchLedger,
        NativeModelInvocationDispatchTarget,
    )>,
) -> Result<EmbeddingResponse, CommandError> {
    let state = state.clone();
    let sqlite = sqlite.clone();
    let dispatch_scope = dispatch_scope.clone();
    // The native worker owns begin -> network -> finish. Dropping the WebView
    // invoke future detaches this join handle even while BEGIN IMMEDIATE is
    // waiting, so registry/lease acquisition cannot be cancelled halfway.
    let worker = tokio::spawn(async move {
        let lease = begin_remote_dispatch(
            &state,
            &sqlite,
            &dispatch_scope,
            prepared.endpoint_is_loopback,
            "embedding",
            &operation_id,
        )
        .await?;
        let invocation_dispatch_receipt = match invocation_dispatch_boundary.as_ref() {
            Some((ledger, target)) => match sqlite
                .mark_model_invocation_dispatched(ledger, target)
                .await
            {
                Ok(receipt) => Some(receipt),
                Err(error) => {
                    let cleanup = finish_remote_dispatch(
                        &state.dispatch_lifecycle,
                        &state.dispatch_registry,
                        &sqlite,
                        lease,
                        &operation_id,
                    )
                    .await;
                    return Err(cleanup
                        .err()
                        .unwrap_or_else(|| map_invocation_dispatch_ledger_error(error)));
                }
            },
            None => None,
        };
        let client = state.client.clone();
        let network_result = AssertUnwindSafe(async move {
            match timeout(request_timeout, execute_embedding(&client, prepared)).await {
                Ok(Ok(mut result)) => {
                    result.invocation_dispatch_receipt = invocation_dispatch_receipt;
                    Ok(result)
                }
                Ok(Err(error)) => Err(error),
                Err(_) => Err(CommandError::timeout()),
            }
        })
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err(CommandError::runtime_failed()));
        finish_remote_dispatch(
            &state.dispatch_lifecycle,
            &state.dispatch_registry,
            &sqlite,
            lease,
            &operation_id,
        )
        .await?;
        network_result
    });
    worker.await.map_err(|_| CommandError::runtime_failed())?
}

fn validate_embedding_invocation_dispatch_ledger_request(
    request: &EmbeddingRequest,
) -> Result<(), CommandError> {
    let Some(ledger) = request.invocation_dispatch_ledger.as_ref() else {
        return Ok(());
    };
    if request.config.retry_limit.unwrap_or(0) != 0
        || !invocation_task_matches_dispatch_scope(
            ledger.task_snapshot.as_str(),
            &request.dispatch_scope,
        )
        || ledger.connection_revision < 1
        || ledger.catalog_entry_revision < 1
        || ledger.model_id_snapshot != request.model
        || !provider_snapshot_matches_protocol(
            ledger.provider_kind_snapshot.as_str(),
            request.config.provider,
        )
    {
        return Err(CommandError::request_invalid());
    }
    Ok(())
}

fn embedding_invocation_dispatch_target(
    request: &EmbeddingRequest,
) -> Result<NativeModelInvocationDispatchTarget, CommandError> {
    model_invocation_dispatch_target_from_config(&request.config, &request.model)
}

#[tauri::command]
pub(crate) async fn rerank_native_model(
    state: State<'_, ModelGatewayState>,
    sqlite: State<'_, NativeSqliteState>,
    request: RerankRequest,
) -> Result<RerankResponse, CommandError> {
    let request_timeout = configured_request_timeout(&request.config)?;
    let prepared = prepare_rerank(&request).await?;
    let operation_id = uuid::Uuid::now_v7().to_string();
    run_prepared_rerank_with_dispatch(
        &state,
        &sqlite,
        &request.dispatch_scope,
        request_timeout,
        prepared,
        operation_id,
    )
    .await
}

async fn run_prepared_rerank_with_dispatch(
    state: &ModelGatewayState,
    sqlite: &NativeSqliteState,
    dispatch_scope: &NativeModelDispatchScope,
    request_timeout: Duration,
    prepared: PreparedRerank,
    operation_id: String,
) -> Result<RerankResponse, CommandError> {
    let state = state.clone();
    let sqlite = sqlite.clone();
    let dispatch_scope = dispatch_scope.clone();
    let worker = tokio::spawn(async move {
        let lease = begin_remote_dispatch(
            &state,
            &sqlite,
            &dispatch_scope,
            prepared.endpoint_is_loopback,
            "rerank",
            &operation_id,
        )
        .await?;
        let client = state.client.clone();
        let network_result = AssertUnwindSafe(async move {
            match timeout(request_timeout, execute_rerank(&client, prepared)).await {
                Ok(result) => result,
                Err(_) => Err(CommandError::timeout()),
            }
        })
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err(CommandError::runtime_failed()));
        finish_remote_dispatch(
            &state.dispatch_lifecycle,
            &state.dispatch_registry,
            &sqlite,
            lease,
            &operation_id,
        )
        .await?;
        network_result
    });
    worker.await.map_err(|_| CommandError::runtime_failed())?
}

#[tauri::command]
pub(crate) async fn start_native_generation(
    app: AppHandle,
    state: State<'_, ModelGatewayState>,
    sqlite: State<'_, NativeSqliteState>,
    request: StartGenerationRequest,
) -> Result<GenerationAccepted, CommandError> {
    validate_generation_id(&request.generation_id)?;
    validate_invocation_dispatch_ledger_request(&request)?;
    let prepared = prepare_generation(&request).await?;
    let invocation_dispatch_boundary = request
        .invocation_dispatch_ledger
        .as_ref()
        .map(|ledger| {
            Ok::<_, CommandError>((ledger.clone(), model_invocation_dispatch_target(&request)?))
        })
        .transpose()?;
    let generation_id = request.generation_id.clone();
    let emitter = GenerationEmitter::new(app, generation_id.clone());
    let invocation_dispatch_receipt = start_prepared_generation_with_dispatch(
        &state,
        &sqlite,
        &request.dispatch_scope,
        prepared,
        generation_id,
        emitter,
        invocation_dispatch_boundary,
    )
    .await?;

    Ok(GenerationAccepted {
        generation_id: request.generation_id,
        accepted: true,
        invocation_dispatch_receipt,
    })
}

fn validate_invocation_dispatch_ledger_request(
    request: &StartGenerationRequest,
) -> Result<(), CommandError> {
    if request.invocation_dispatch_ledger.is_none() {
        return Ok(());
    }
    let ledger = request
        .invocation_dispatch_ledger
        .as_ref()
        .ok_or_else(CommandError::request_invalid)?;
    if request.config.retry_limit.unwrap_or(0) != 0
        || !invocation_task_matches_dispatch_scope(
            ledger.task_snapshot.as_str(),
            &request.dispatch_scope,
        )
    {
        return Err(CommandError::request_invalid());
    }
    if ledger.connection_revision < 1
        || ledger.catalog_entry_revision < 1
        || ledger.model_id_snapshot != request.model
        || !provider_snapshot_matches_protocol(
            ledger.provider_kind_snapshot.as_str(),
            request.config.provider,
        )
    {
        return Err(CommandError::request_invalid());
    }
    // The Model Hub connection and the InkShadow-owned credential vault slot
    // deliberately have independent identities. The authoritative SQLite
    // dispatch receipt validates the connection revision and its credential
    // reference before any Provider request starts; equating the two here
    // rejects every remote quick probe while loopback connections pass by chance.
    Ok(())
}

fn invocation_task_matches_dispatch_scope(task: &str, scope: &NativeModelDispatchScope) -> bool {
    if !valid_model_invocation_dispatch_task(task) {
        return false;
    }
    match scope {
        NativeModelDispatchScope::NonProject { reason } => match reason {
            crate::native_sqlite::NativeNonProjectDispatchReason::CreativeOpening => {
                task == "book_start_guidance"
            }
            crate::native_sqlite::NativeNonProjectDispatchReason::ConnectionProbe => {
                task == "capability_probe"
            }
            crate::native_sqlite::NativeNonProjectDispatchReason::NovelSkillEvaluation => {
                task != "capability_probe"
            }
        },
        NativeModelDispatchScope::ProjectContext { .. } => task != "capability_probe",
    }
}

fn provider_snapshot_matches_protocol(snapshot: &str, provider: ProviderKind) -> bool {
    match provider {
        ProviderKind::OpenAiCompatible => matches!(
            snapshot,
            "openai"
                | "deepseek"
                | "zhipu_glm"
                | "alibaba_qwen"
                | "volcengine_doubao"
                | "custom_openai_compatible"
        ),
        ProviderKind::Ollama => snapshot == "ollama",
        ProviderKind::Anthropic => snapshot == "anthropic_claude",
        ProviderKind::Gemini => snapshot == "google_gemini",
    }
}

fn model_invocation_dispatch_target(
    request: &StartGenerationRequest,
) -> Result<NativeModelInvocationDispatchTarget, CommandError> {
    model_invocation_dispatch_target_from_config(&request.config, &request.model)
}

fn model_invocation_dispatch_target_from_config(
    config: &ModelEndpointConfig,
    model: &str,
) -> Result<NativeModelInvocationDispatchTarget, CommandError> {
    Ok(NativeModelInvocationDispatchTarget {
        protocol: match config.provider {
            ProviderKind::OpenAiCompatible => "openai_compatible",
            ProviderKind::Ollama => "ollama",
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::Gemini => "gemini",
        }
        .to_owned(),
        credential_provider_id: config.provider_id.clone(),
        base_url: config.base_url.clone(),
        authentication_mode: match config.authentication {
            AuthenticationMode::None => "none",
            AuthenticationMode::BearerKeyring => "bearer_keyring",
            AuthenticationMode::CustomHeaderKeyring => "custom_header_keyring",
        }
        .to_owned(),
        credential_header_name: config.credential_header_name.clone(),
        model_discovery_path: config.model_discovery_path.clone(),
        text_generation_path: config.text_generation_path.clone(),
        embedding_path: config.embedding_path.clone(),
        request_timeout_ms: i64::try_from(configured_request_timeout(config)?.as_millis())
            .map_err(|_| CommandError::request_invalid())?,
        model_id: model.to_owned(),
    })
}

async fn start_prepared_generation_with_dispatch<Emitter>(
    state: &ModelGatewayState,
    sqlite: &NativeSqliteState,
    dispatch_scope: &NativeModelDispatchScope,
    prepared: PreparedGeneration,
    generation_id: String,
    mut emitter: Emitter,
    invocation_dispatch_boundary: Option<(
        NativeModelInvocationDispatchLedger,
        NativeModelInvocationDispatchTarget,
    )>,
) -> Result<Option<NativeModelInvocationDispatchReceipt>, CommandError>
where
    Emitter: GenerationEventSink + 'static,
{
    let state = state.clone();
    let sqlite = sqlite.clone();
    let dispatch_scope = dispatch_scope.clone();
    let (startup_tx, startup_rx) = tokio::sync::oneshot::channel();
    // Spawn before registration or BEGIN IMMEDIATE. The native task therefore
    // owns every stateful step even if the invoke future waiting on startup is
    // dropped by its caller.
    tokio::spawn(async move {
        let cancellation = match state.registry.register(&generation_id) {
            Ok(cancellation) => cancellation,
            Err(error) => {
                let _ = startup_tx.send(Err(error));
                return;
            }
        };
        let lease = match begin_remote_dispatch(
            &state,
            &sqlite,
            &dispatch_scope,
            prepared.endpoint_is_loopback,
            "generation",
            &generation_id,
        )
        .await
        {
            Ok(lease) => lease,
            Err(error) => {
                let _ = state.registry.remove(&generation_id);
                let _ = startup_tx.send(Err(error));
                return;
            }
        };
        let started = std::panic::catch_unwind(AssertUnwindSafe(|| {
            emitter.emit_status(GenerationEventStatus::Started, String::new())
        }))
        .unwrap_or_else(|_| Err(CommandError::runtime_failed()));
        if let Err(emit_error) = started {
            let cleanup = finish_remote_dispatch(
                &state.dispatch_lifecycle,
                &state.dispatch_registry,
                &sqlite,
                lease,
                &generation_id,
            )
            .await;
            let _ = state.registry.remove(&generation_id);
            let _ = startup_tx.send(Err(cleanup.err().unwrap_or(emit_error)));
            return;
        }

        let invocation_dispatch_receipt = match invocation_dispatch_boundary.as_ref() {
            Some((ledger, target)) => match sqlite
                .mark_model_invocation_dispatched(ledger, target)
                .await
            {
                Ok(receipt) => Some(receipt),
                Err(error) => {
                    let cleanup = finish_remote_dispatch(
                        &state.dispatch_lifecycle,
                        &state.dispatch_registry,
                        &sqlite,
                        lease,
                        &generation_id,
                    )
                    .await;
                    let _ = state.registry.remove(&generation_id);
                    let _ = startup_tx.send(Err(cleanup
                        .err()
                        .unwrap_or_else(|| map_invocation_dispatch_ledger_error(error))));
                    return;
                }
            },
            None => None,
        };

        // Failure to deliver the handshake only means the invoke waiter was
        // dropped. It must not cancel a generation whose native lifecycle is
        // already fenced and active.
        let _ = startup_tx.send(Ok(invocation_dispatch_receipt));
        drive_generation(NativeGenerationLifecycle {
            state,
            sqlite,
            prepared,
            cancellation,
            generation_id,
            emitter,
            lease,
        })
        .await;
    });

    startup_rx
        .await
        .map_err(|_| CommandError::runtime_failed())?
}

fn map_invocation_dispatch_ledger_error(error: ModelInvocationDispatchLedgerError) -> CommandError {
    match error {
        ModelInvocationDispatchLedgerError::Invalid => CommandError::request_invalid(),
        ModelInvocationDispatchLedgerError::Conflict => CommandError::new(
            "MODEL_INVOCATION_DISPATCH_CONFLICT",
            "The model invocation changed before native dispatch. No provider request was sent.",
            false,
            vec!["RETRY"],
        ),
        ModelInvocationDispatchLedgerError::Busy
        | ModelInvocationDispatchLedgerError::Unavailable => CommandError::new(
            "MODEL_INVOCATION_DISPATCH_LEDGER_UNAVAILABLE",
            "The native gateway could not persist the provider dispatch boundary. No provider request was sent.",
            true,
            vec!["RETRY", "OPEN_DIAGNOSTICS"],
        ),
        ModelInvocationDispatchLedgerError::OutcomeUnknown => CommandError::new(
            "MODEL_INVOCATION_DISPATCH_LEDGER_OUTCOME_UNKNOWN",
            "The native invocation receipt could not be confirmed. No provider request was started and the operation will not be resent automatically.",
            false,
            vec!["OPEN_DIAGNOSTICS"],
        ),
    }
}

#[tauri::command]
pub(crate) async fn reconcile_native_model_dispatch_leases(
    state: State<'_, ModelGatewayState>,
    sqlite: State<'_, NativeSqliteState>,
) -> Result<u64, CommandError> {
    reconcile_remote_dispatch_leases(&state, &sqlite).await
}

async fn reconcile_remote_dispatch_leases(
    state: &ModelGatewayState,
    sqlite: &NativeSqliteState,
) -> Result<u64, CommandError> {
    reconcile_remote_dispatch_leases_with_snapshot_pause(state, sqlite, std::future::ready(()))
        .await
}

async fn reconcile_remote_dispatch_leases_with_snapshot_pause<Pause>(
    state: &ModelGatewayState,
    sqlite: &NativeSqliteState,
    snapshot_pause: Pause,
) -> Result<u64, CommandError>
where
    Pause: std::future::Future<Output = ()>,
{
    let _lifecycle = state.dispatch_lifecycle.lock().await;
    let active = state.dispatch_registry.snapshot()?;
    // Production passes a ready future. Tests use this seam to hold the exact
    // historical snapshot-to-SQL race window open and prove that acquisition
    // cannot enter it while the lifecycle lock is held.
    snapshot_pause.await;
    sqlite
        .reconcile_project_remote_dispatch_leases(&active)
        .await
        .map_err(map_dispatch_lease_error)
}

async fn begin_remote_dispatch(
    state: &ModelGatewayState,
    sqlite: &NativeSqliteState,
    scope: &NativeModelDispatchScope,
    endpoint_is_loopback: bool,
    operation_kind: &str,
    operation_id: &str,
) -> Result<Option<ProjectRemoteDispatchLease>, CommandError> {
    let _lifecycle = state.dispatch_lifecycle.lock().await;
    state.dispatch_registry.register(operation_id)?;
    match acquire_remote_dispatch_lease(
        sqlite,
        scope,
        endpoint_is_loopback,
        operation_kind,
        operation_id,
    )
    .await
    {
        Ok(lease) => Ok(lease),
        Err(error) => {
            let _ = state.dispatch_registry.remove(operation_id);
            Err(error)
        }
    }
}

async fn finish_remote_dispatch(
    lifecycle: &AsyncMutex<()>,
    registry: &ActiveDispatchRegistry,
    sqlite: &NativeSqliteState,
    lease: Option<ProjectRemoteDispatchLease>,
    operation_id: &str,
) -> Result<(), CommandError> {
    let _lifecycle = lifecycle.lock().await;
    // Keep the lifecycle ordering identical to begin/reconcile:
    // lifecycle -> native registry -> SQLite. Reconciliation also takes the
    // lifecycle lock, so it cannot observe the short registry/lease mismatch.
    // If registry removal fails, retaining the durable lease is the safe side
    // of the privacy boundary and a later in-process reconciliation can clear
    // it once the registry is available again.
    if !registry.remove(operation_id)? {
        return Err(CommandError::registry_unavailable());
    }
    release_remote_dispatch_lease(sqlite, lease).await
}

async fn acquire_remote_dispatch_lease(
    sqlite: &NativeSqliteState,
    scope: &NativeModelDispatchScope,
    endpoint_is_loopback: bool,
    operation_kind: &str,
    operation_id: &str,
) -> Result<Option<ProjectRemoteDispatchLease>, CommandError> {
    let receipt = match scope {
        NativeModelDispatchScope::NonProject { reason } => {
            match reason {
                crate::native_sqlite::NativeNonProjectDispatchReason::CreativeOpening
                | crate::native_sqlite::NativeNonProjectDispatchReason::ConnectionProbe
                | crate::native_sqlite::NativeNonProjectDispatchReason::NovelSkillEvaluation => {}
            }
            return Ok(None);
        }
        NativeModelDispatchScope::ProjectContext { receipt } => receipt,
    };
    sqlite
        .acquire_project_remote_dispatch_lease(
            receipt,
            endpoint_is_loopback,
            operation_kind,
            operation_id,
        )
        .await
        .map(Some)
        .map_err(map_dispatch_lease_error)
}

async fn release_remote_dispatch_lease(
    sqlite: &NativeSqliteState,
    lease: Option<ProjectRemoteDispatchLease>,
) -> Result<(), CommandError> {
    let Some(lease) = lease else {
        return Ok(());
    };
    sqlite
        .release_project_remote_dispatch_lease(&lease)
        .await
        .map_err(map_dispatch_lease_error)
}

fn map_dispatch_lease_error(error: ProjectRemoteDispatchLeaseError) -> CommandError {
    match error {
        ProjectRemoteDispatchLeaseError::AuthorityChanged => {
            CommandError::project_context_privacy_changed()
        }
        ProjectRemoteDispatchLeaseError::PrivateChapterLocalOnly => {
            CommandError::private_chapter_local_only()
        }
        ProjectRemoteDispatchLeaseError::DatabaseBusy
        | ProjectRemoteDispatchLeaseError::DatabaseUnavailable => {
            CommandError::project_context_privacy_unavailable()
        }
    }
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
                top_p: request.top_p,
                thinking: request.reasoning_mode.map(|mode| OpenAiThinking { mode }),
                response_format: request
                    .response_format
                    .map(|format| OpenAiResponseFormat { format }),
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
                    top_p: request.top_p,
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
        endpoint_is_loopback: endpoint.is_loopback(),
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
        top_p: request.top_p,
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
            top_p: request.top_p,
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
        endpoint_is_loopback: endpoint.is_loopback(),
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
        invocation_dispatch_receipt: None,
    })
}

#[cfg(test)]
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
        endpoint_is_loopback: endpoint.is_loopback(),
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
        || request
            .top_p
            .is_some_and(|top_p| !top_p.is_finite() || !(0.0..=1.0).contains(&top_p))
    {
        return Err(CommandError::request_invalid());
    }
    if (request.reasoning_mode.is_some() || request.response_format.is_some())
        && request.config.provider != ProviderKind::OpenAiCompatible
    {
        return Err(CommandError::operation_unsupported());
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

async fn drive_generation<Emitter>(lifecycle: NativeGenerationLifecycle<Emitter>)
where
    Emitter: GenerationEventSink,
{
    let NativeGenerationLifecycle {
        state,
        sqlite,
        prepared,
        cancellation,
        generation_id,
        mut emitter,
        lease,
    } = lifecycle;
    let result = AssertUnwindSafe(timeout(
        GENERATION_TIMEOUT,
        stream_generation(&state.client, prepared, &cancellation, &mut emitter),
    ))
    .catch_unwind()
    .await
    .unwrap_or_else(|_| Ok(Err(CommandError::runtime_failed())));

    let status = finalize_generation_dispatch(
        &sqlite,
        lease,
        &state.dispatch_registry,
        &state.dispatch_lifecycle,
        &generation_id,
        result,
    )
    .await;
    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
        emitter.emit_status(status, String::new())
    }));
    let _ = state.registry.remove(&generation_id);
}

async fn finalize_generation_dispatch(
    sqlite: &NativeSqliteState,
    lease: Option<ProjectRemoteDispatchLease>,
    dispatch_registry: &ActiveDispatchRegistry,
    dispatch_lifecycle: &AsyncMutex<()>,
    generation_id: &str,
    result: Result<Result<RunOutcome, CommandError>, tokio::time::error::Elapsed>,
) -> GenerationEventStatus {
    let status = if let Err(error) = finish_remote_dispatch(
        dispatch_lifecycle,
        dispatch_registry,
        sqlite,
        lease,
        generation_id,
    )
    .await
    {
        failed_generation_status(error)
    } else {
        match result {
            Ok(Ok(RunOutcome::Completed { usage, streamed })) => {
                GenerationEventStatus::Completed { usage, streamed }
            }
            Ok(Ok(RunOutcome::Cancelled)) => GenerationEventStatus::Cancelled,
            Ok(Err(error)) => failed_generation_status(error),
            Err(_) => failed_generation_status(CommandError::timeout()),
        }
    };
    status
}

fn failed_generation_status(error: CommandError) -> GenerationEventStatus {
    GenerationEventStatus::Failed {
        code: error.code(),
        retryable: error.retryable(),
        request_id: error.request_id().to_owned(),
        http_status: error.http_status(),
        finish_reason: error.finish_reason().map(str::to_owned),
        reasoning_present: error.reasoning_present(),
        reasoning_length: error.reasoning_length(),
        stream: error.stream(),
        usage: error.usage().cloned(),
    }
}

async fn stream_generation<Emitter: GenerationDeltaSink>(
    client: &Client,
    prepared: PreparedGeneration,
    cancellation: &CancellationToken,
    emitter: &mut Emitter,
) -> Result<RunOutcome, CommandError> {
    let mut observation = GenerationObservation::default();
    let result =
        stream_generation_observed(client, prepared, cancellation, emitter, &mut observation).await;
    result.map_err(|error| observation.attach(error))
}

async fn stream_generation_observed<Emitter: GenerationDeltaSink>(
    client: &Client,
    prepared: PreparedGeneration,
    cancellation: &CancellationToken,
    emitter: &mut Emitter,
    observation: &mut GenerationObservation,
) -> Result<RunOutcome, CommandError> {
    if cancellation.is_cancelled() {
        return Ok(RunOutcome::Cancelled);
    }

    let provider = prepared.provider;

    let request = apply_provider_headers(
        client
            .post(prepared.url)
            .header(CONTENT_TYPE, "application/json")
            .header(
                ACCEPT,
                match provider {
                    ProviderKind::OpenAiCompatible => "text/event-stream",
                    ProviderKind::Ollama => "application/x-ndjson",
                    ProviderKind::Anthropic | ProviderKind::Gemini => "text/event-stream",
                },
            )
            .body(prepared.body),
        provider,
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
    observation.http_status = Some(response.status().as_u16());
    assert_success_status(&response)?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(CommandError::response_limit_exceeded());
    }

    let mut parser = match provider {
        ProviderKind::OpenAiCompatible => {
            ProviderStreamParser::OpenAi(OpenAiResponseParser::default())
        }
        ProviderKind::Ollama => ProviderStreamParser::Ollama(OllamaNdjsonParser::default()),
        ProviderKind::Anthropic => ProviderStreamParser::Anthropic(AnthropicSseParser::default()),
        ProviderKind::Gemini => ProviderStreamParser::Gemini(GeminiSseParser::default()),
    };
    observation.stream = parser.streamed();
    if provider == ProviderKind::OpenAiCompatible && observation.stream.is_some() {
        observation.reasoning_present = Some(false);
    }
    let mut response_bytes = 0usize;
    let mut output_bytes = 0usize;

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
            let parsed = parser.finish();
            observe_parser_mode(provider, &parser, observation)?;
            let items = parsed?;
            if process_stream_items(items, &mut output_bytes, observation, emitter)? {
                let streamed = observation
                    .stream
                    .ok_or_else(CommandError::response_invalid)?;
                return Ok(RunOutcome::Completed {
                    usage: observation.usage.clone(),
                    streamed,
                });
            }
            return Err(CommandError::stream_truncated());
        };

        response_bytes = response_bytes
            .checked_add(chunk.len())
            .ok_or_else(CommandError::response_limit_exceeded)?;
        if response_bytes > MAX_RESPONSE_BYTES {
            return Err(CommandError::response_limit_exceeded());
        }
        let parsed = parser.push(&chunk);
        observe_parser_mode(provider, &parser, observation)?;
        let items = parsed?;
        if process_stream_items(items, &mut output_bytes, observation, emitter)? {
            let streamed = observation
                .stream
                .ok_or_else(CommandError::response_invalid)?;
            return Ok(RunOutcome::Completed {
                usage: observation.usage.clone(),
                streamed,
            });
        }
    }
}

fn observe_parser_mode(
    provider: ProviderKind,
    parser: &ProviderStreamParser,
    observation: &mut GenerationObservation,
) -> Result<(), CommandError> {
    let Some(streamed) = parser.streamed() else {
        return Ok(());
    };
    if observation
        .stream
        .is_some_and(|current| current != streamed)
    {
        return Err(CommandError::response_invalid());
    }
    observation.stream = Some(streamed);
    if provider == ProviderKind::OpenAiCompatible && observation.reasoning_present.is_none() {
        observation.reasoning_present = Some(false);
    }
    Ok(())
}

fn process_stream_items<Emitter: GenerationDeltaSink>(
    items: Vec<StreamItem>,
    output_bytes: &mut usize,
    observation: &mut GenerationObservation,
    emitter: &mut Emitter,
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
            StreamItem::Reasoning { length } => {
                observation.reasoning_present = Some(true);
                observation.reasoning_length = Some(
                    observation
                        .reasoning_length
                        .unwrap_or_default()
                        .checked_add(length)
                        .ok_or_else(CommandError::response_limit_exceeded)?,
                );
            }
            StreamItem::Usage(next) => {
                if observation
                    .usage
                    .as_ref()
                    .is_some_and(|current| current != &next)
                {
                    return Err(CommandError::response_invalid());
                }
                observation.usage = Some(next);
            }
            StreamItem::FinishReason(reason) => {
                if observation
                    .finish_reason
                    .as_ref()
                    .is_some_and(|current| current != &reason)
                {
                    return Err(CommandError::response_invalid());
                }
                let truncated = matches!(
                    reason.as_str(),
                    "length" | "max_tokens" | "max_output_tokens"
                );
                observation.finish_reason = Some(reason);
                if truncated {
                    return Err(CommandError::output_truncated());
                }
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
        AuthenticationMode, EmbeddingRequest, ModelMessageRole, ProviderKind, ReasoningMode,
        RerankProtocol, RerankRequest, ResponseFormat, StartGenerationRequest,
    };
    use crate::native_sqlite::{
        canonical_project_context_fingerprint, NativeProjectContextChapterAuthority,
        NativeProjectContextPrivacyReceipt,
    };
    use sqlx::{
        sqlite::{SqliteConnectOptions, SqliteJournalMode},
        Connection, SqliteConnection,
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

    struct GatedFakeServer {
        base_url: String,
        release: std::sync::mpsc::SyncSender<()>,
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

    fn spawn_gated_fake_server(status: &str, body: &[u8]) -> GatedFakeServer {
        let listener =
            TcpListener::bind("127.0.0.1:0").expect("gated model server should bind loopback");
        let address = listener
            .local_addr()
            .expect("gated model server should have an address");
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let status = status.to_owned();
        let body = body.to_vec();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("gated server should accept");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("read timeout should apply");
            let _ = read_http_request(&mut stream);
            release_rx
                .recv()
                .expect("test should release the gated response");
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(&body);
        });
        GatedFakeServer {
            base_url: format!("http://{address}"),
            release: release_tx,
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

    fn test_dispatch_scope() -> NativeModelDispatchScope {
        NativeModelDispatchScope::NonProject {
            reason: crate::native_sqlite::NativeNonProjectDispatchReason::ConnectionProbe,
        }
    }

    async fn seeded_empty_remote_project(
        label: &str,
        project_id: &str,
    ) -> (
        std::path::PathBuf,
        Arc<NativeSqliteState>,
        NativeModelDispatchScope,
    ) {
        let directory = std::env::temp_dir().join(format!(
            "inkshadow-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir(&directory).expect("create dispatch fixture directory");
        let database_path = directory.join("inkshadow.db");
        let sqlite = Arc::new(NativeSqliteState::default());
        sqlite
            .test_open_migrated_database(&database_path)
            .await
            .expect("open migrated dispatch fixture");
        sqlite
            .test_execute_internal_sql(&format!(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES \
                 ('{project_id}', 'Dispatch fixture', '2026-08-08T00:00:00.000Z', \
                 '2026-08-08T00:00:00.000Z')"
            ))
            .await
            .expect("seed empty dispatch project");
        let mut receipt = NativeProjectContextPrivacyReceipt {
            schema_version: 1,
            project_id: project_id.to_owned(),
            fingerprint: String::new(),
            active_chapter_count: 0,
            retained_chapter_count: 0,
            requires_verified_local: false,
            chapters: vec![],
        };
        receipt.fingerprint = canonical_project_context_fingerprint(&receipt)
            .expect("canonical empty-project fingerprint");
        (
            directory,
            sqlite,
            NativeModelDispatchScope::ProjectContext { receipt },
        )
    }

    async fn open_dispatch_inspector(database_path: &std::path::Path) -> SqliteConnection {
        SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(database_path)
                .create_if_missing(false)
                .foreign_keys(true)
                .journal_mode(SqliteJournalMode::Wal)
                .busy_timeout(Duration::from_secs(1)),
        )
        .await
        .expect("open independent dispatch inspector")
    }

    async fn dispatch_lease_count(connection: &mut SqliteConnection) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM project_remote_dispatch_leases")
            .fetch_one(connection)
            .await
            .expect("count remote dispatch leases")
    }

    async fn wait_for_dispatch_lease_count(connection: &mut SqliteConnection, expected: i64) {
        for _ in 0..1_000 {
            if dispatch_lease_count(connection).await == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(dispatch_lease_count(connection).await, expected);
    }

    async fn wait_for_dispatch_registry_entry(state: &ModelGatewayState, operation_id: &str) {
        for _ in 0..1_000 {
            if state
                .dispatch_registry
                .snapshot()
                .expect("snapshot dispatch registry")
                .contains(operation_id)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(state
            .dispatch_registry
            .snapshot()
            .expect("final dispatch registry snapshot")
            .contains(operation_id));
    }

    async fn wait_for_generation_registry_absence(state: &ModelGatewayState, generation_id: &str) {
        for _ in 0..1_000 {
            if !state
                .registry
                .contains(generation_id)
                .expect("inspect generation registry")
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!state
            .registry
            .contains(generation_id)
            .expect("final generation registry inspection"));
    }

    fn embedding_request(
        base_url: String,
        provider: ProviderKind,
        model: &str,
        inputs: &[&str],
    ) -> EmbeddingRequest {
        EmbeddingRequest {
            dispatch_scope: test_dispatch_scope(),
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
            invocation_dispatch_ledger: None,
        }
    }

    async fn seeded_non_project_embedding_invocation(
        label: &str,
        base_url: &str,
        request_timeout_ms: u64,
        invocation_id: &str,
    ) -> (std::path::PathBuf, NativeSqliteState, EmbeddingRequest) {
        let directory = std::env::temp_dir().join(format!(
            "inkshadow-embedding-ledger-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir(&directory).expect("create embedding ledger test directory");
        let database_path = directory.join("inkshadow.db");
        let sqlite = NativeSqliteState::default();
        sqlite
            .test_open_migrated_database(&database_path)
            .await
            .expect("open migrated embedding ledger database");
        sqlite
            .test_execute_internal_sql(&format!(
                "INSERT INTO model_provider_connections (
                   id, provider_kind, display_name, protocol, base_url,
                   authentication_mode, request_timeout_ms, retry_limit,
                   created_at, updated_at
                 ) VALUES (
                   'native-embedding-ledger', 'custom_openai_compatible',
                   'Native embedding ledger', 'openai_compatible', '{base_url}/v1',
                   'none', {request_timeout_ms}, 0,
                   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
                 )"
            ))
            .await
            .expect("seed embedding ledger connection");
        sqlite
            .test_execute_internal_sql(
                "INSERT INTO model_catalog_entries (
                   id, connection_id, provider_model_id, display_name, catalog_source,
                   availability, lifecycle, first_discovered_at, last_seen_at
                 ) VALUES (
                   'native-embedding-catalog', 'native-embedding-ledger', 'embed-1',
                   'embed-1', 'manual', 'available', 'stable',
                   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
                 )",
            )
            .await
            .expect("seed embedding ledger catalog");
        sqlite
            .test_execute_internal_sql(&format!(
                "INSERT INTO model_invocation_facts (
                   id, task, connection_id, catalog_entry_id,
                   provider_kind_snapshot, model_id_snapshot,
                   route_reason, status, attempt, privacy_policy, data_destination,
                   started_at, created_at, revision
                 ) VALUES (
                   '{invocation_id}', 'capability_probe', 'native-embedding-ledger',
                   'native-embedding-catalog', 'custom_openai_compatible', 'embed-1',
                   'user_override', 'running', 1, 'cloud_allowed', 'remote',
                   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z', 1
                 )"
            ))
            .await
            .expect("seed running embedding invocation");
        let mut request = embedding_request(
            format!("{base_url}/v1"),
            ProviderKind::OpenAiCompatible,
            "embed-1",
            &["fixed private embedding probe"],
        );
        request.config.provider_id = "native-embedding-ledger".to_owned();
        request.config.request_timeout_ms = Some(request_timeout_ms);
        request.config.retry_limit = Some(0);
        request.dispatch_scope = NativeModelDispatchScope::NonProject {
            reason: crate::native_sqlite::NativeNonProjectDispatchReason::ConnectionProbe,
        };
        request.invocation_dispatch_ledger = Some(NativeModelInvocationDispatchLedger {
            invocation_id: invocation_id.to_owned(),
            task_snapshot: "capability_probe".to_owned(),
            expected_revision: 1,
            connection_id: "native-embedding-ledger".to_owned(),
            connection_revision: 1,
            catalog_entry_id: "native-embedding-catalog".to_owned(),
            catalog_entry_revision: 1,
            provider_kind_snapshot: "custom_openai_compatible".to_owned(),
            model_id_snapshot: "embed-1".to_owned(),
        });
        (directory, sqlite, request)
    }

    fn generation_request() -> StartGenerationRequest {
        StartGenerationRequest {
            dispatch_scope: test_dispatch_scope(),
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
            top_p: None,
            reasoning_mode: None,
            response_format: None,
            invocation_dispatch_ledger: None,
        }
    }

    fn invocation_dispatch_boundary(
        request: &StartGenerationRequest,
        invocation_id: &str,
        connection_id: &str,
        connection_revision: i64,
        catalog_entry_id: &str,
        catalog_entry_revision: i64,
        provider_kind_snapshot: &str,
    ) -> (
        NativeModelInvocationDispatchLedger,
        NativeModelInvocationDispatchTarget,
    ) {
        (
            NativeModelInvocationDispatchLedger {
                invocation_id: invocation_id.to_owned(),
                task_snapshot: match &request.dispatch_scope {
                    NativeModelDispatchScope::NonProject { reason } => match reason {
                        crate::native_sqlite::NativeNonProjectDispatchReason::CreativeOpening => {
                            "book_start_guidance"
                        }
                        crate::native_sqlite::NativeNonProjectDispatchReason::ConnectionProbe => {
                            "capability_probe"
                        }
                        crate::native_sqlite::NativeNonProjectDispatchReason::NovelSkillEvaluation => {
                            "continuation"
                        }
                    },
                    NativeModelDispatchScope::ProjectContext { .. } => "continuation",
                }
                .to_owned(),
                expected_revision: 1,
                connection_id: connection_id.to_owned(),
                connection_revision,
                catalog_entry_id: catalog_entry_id.to_owned(),
                catalog_entry_revision,
                provider_kind_snapshot: provider_kind_snapshot.to_owned(),
                model_id_snapshot: request.model.clone(),
            },
            model_invocation_dispatch_target(request).expect("valid capability dispatch target"),
        )
    }

    fn rerank_request(base_url: String) -> RerankRequest {
        RerankRequest {
            dispatch_scope: test_dispatch_scope(),
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

        let mut minimum_top_p = generation_request();
        minimum_top_p.top_p = Some(0.0);
        assert!(validate_generation_request(&minimum_top_p).is_ok());

        let mut maximum_top_p = generation_request();
        maximum_top_p.top_p = Some(1.0);
        assert!(validate_generation_request(&maximum_top_p).is_ok());

        let mut empty_messages = generation_request();
        empty_messages.messages.clear();
        assert!(validate_generation_request(&empty_messages).is_err());

        let mut oversized = generation_request();
        oversized.messages[0].content = "x".repeat(MAX_INPUT_BYTES + 1);
        assert!(validate_generation_request(&oversized).is_err());

        let mut invalid_temperature = generation_request();
        invalid_temperature.temperature = Some(f32::NAN);
        assert!(validate_generation_request(&invalid_temperature).is_err());

        for invalid in [-0.01, 1.01, f32::NAN, f32::INFINITY] {
            let mut invalid_top_p = generation_request();
            invalid_top_p.top_p = Some(invalid);
            assert!(
                validate_generation_request(&invalid_top_p).is_err(),
                "top_p={invalid:?} must be rejected"
            );
        }
    }

    #[test]
    fn invocation_receipt_accepts_capability_probe_and_creative_opening_zero_retry_scopes() {
        let mut request = generation_request();
        request.config.provider_id = "owned-credential-slot-1".to_owned();
        request.dispatch_scope = NativeModelDispatchScope::NonProject {
            reason: crate::native_sqlite::NativeNonProjectDispatchReason::CreativeOpening,
        };
        request.invocation_dispatch_ledger = Some(NativeModelInvocationDispatchLedger {
            invocation_id: "019f9f4a-b3c7-7350-9226-000000000503".to_owned(),
            task_snapshot: "capability_probe".to_owned(),
            expected_revision: 1,
            connection_id: "connection-1".to_owned(),
            connection_revision: 1,
            catalog_entry_id: "catalog-1".to_owned(),
            catalog_entry_revision: 1,
            provider_kind_snapshot: "openai".to_owned(),
            model_id_snapshot: "model-1".to_owned(),
        });
        assert!(validate_invocation_dispatch_ledger_request(&request).is_err());

        request.dispatch_scope = NativeModelDispatchScope::NonProject {
            reason: crate::native_sqlite::NativeNonProjectDispatchReason::ConnectionProbe,
        };
        request.config.retry_limit = Some(1);
        assert!(validate_invocation_dispatch_ledger_request(&request).is_err());

        request.config.retry_limit = Some(0);
        assert!(
            validate_invocation_dispatch_ledger_request(&request).is_ok(),
            "an InkShadow-owned credential slot is intentionally independent from the Model Hub connection id"
        );
        request.dispatch_scope = NativeModelDispatchScope::NonProject {
            reason: crate::native_sqlite::NativeNonProjectDispatchReason::CreativeOpening,
        };
        request
            .invocation_dispatch_ledger
            .as_mut()
            .expect("test ledger")
            .task_snapshot = "book_start_guidance".to_owned();
        assert!(validate_invocation_dispatch_ledger_request(&request).is_ok());
        request
            .invocation_dispatch_ledger
            .as_mut()
            .expect("test ledger")
            .model_id_snapshot = "different-model".to_owned();
        assert!(validate_invocation_dispatch_ledger_request(&request).is_err());
    }

    #[test]
    fn embedding_invocation_receipt_requires_exact_zero_retry_scope_and_identity() {
        let mut request = embedding_request(
            "http://127.0.0.1:11434/v1".to_owned(),
            ProviderKind::OpenAiCompatible,
            "embed-1",
            &["fixed probe"],
        );
        request.dispatch_scope = NativeModelDispatchScope::ProjectContext {
            receipt: NativeProjectContextPrivacyReceipt {
                schema_version: 1,
                project_id: "019f9f4a-b3c7-7350-9226-000000000607".to_owned(),
                fingerprint: "a".repeat(64),
                active_chapter_count: 0,
                retained_chapter_count: 0,
                requires_verified_local: false,
                chapters: vec![],
            },
        };
        request.invocation_dispatch_ledger = Some(NativeModelInvocationDispatchLedger {
            invocation_id: "019f9f4a-b3c7-7350-9226-000000000604".to_owned(),
            task_snapshot: "embedding".to_owned(),
            expected_revision: 1,
            connection_id: "connection-1".to_owned(),
            connection_revision: 1,
            catalog_entry_id: "catalog-1".to_owned(),
            catalog_entry_revision: 1,
            provider_kind_snapshot: "custom_openai_compatible".to_owned(),
            model_id_snapshot: "embed-1".to_owned(),
        });
        assert!(validate_embedding_invocation_dispatch_ledger_request(&request).is_ok());

        request.config.retry_limit = Some(1);
        assert!(validate_embedding_invocation_dispatch_ledger_request(&request).is_err());
        request.config.retry_limit = Some(0);
        request
            .invocation_dispatch_ledger
            .as_mut()
            .expect("embedding ledger")
            .model_id_snapshot = "different-model".to_owned();
        assert!(validate_embedding_invocation_dispatch_ledger_request(&request).is_err());
        request
            .invocation_dispatch_ledger
            .as_mut()
            .expect("embedding ledger")
            .model_id_snapshot = "embed-1".to_owned();
        request.dispatch_scope = NativeModelDispatchScope::NonProject {
            reason: crate::native_sqlite::NativeNonProjectDispatchReason::ConnectionProbe,
        };
        assert!(validate_embedding_invocation_dispatch_ledger_request(&request).is_err());
        request
            .invocation_dispatch_ledger
            .as_mut()
            .expect("embedding ledger")
            .task_snapshot = "capability_probe".to_owned();
        assert!(validate_embedding_invocation_dispatch_ledger_request(&request).is_ok());
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

    #[tokio::test]
    async fn serializes_provider_specific_requests_with_hard_output_limits() {
        let mut request = generation_request();
        request.top_p = Some(0.5);
        let openai = OpenAiGenerationBody {
            model: &request.model,
            messages: &request.messages,
            stream: true,
            max_tokens: request.max_output_tokens,
            stream_options: OpenAiStreamOptions {
                include_usage: true,
            },
            temperature: request.temperature,
            top_p: request.top_p,
            thinking: None,
            response_format: None,
        };
        let body = serialize_request_body(&openai).expect("request should serialize");
        let value: serde_json::Value =
            serde_json::from_slice(&body).expect("serialized request should be JSON");

        assert_eq!(value["stream"], true);
        assert_eq!(value["stream_options"]["include_usage"], true);
        assert_eq!(value["max_tokens"], 1_024);
        assert_eq!(value["messages"][0]["role"], "user");
        assert_eq!(value["messages"][0]["content"], "Write a safe candidate.");
        assert_eq!(value["top_p"], 0.5);

        let mut ollama_request = request.clone();
        ollama_request.config.provider = ProviderKind::Ollama;
        ollama_request.config.base_url = "http://127.0.0.1:11434".to_owned();
        let prepared = prepare_generation(&ollama_request)
            .await
            .expect("Ollama request should prepare");
        let value: serde_json::Value =
            serde_json::from_slice(&prepared.body).expect("Ollama body should be JSON");
        assert_eq!(value["options"]["top_p"], 0.5);

        request.top_p = None;
        let prepared = prepare_generation(&request)
            .await
            .expect("OpenAI-compatible default sampling should prepare");
        let value: serde_json::Value =
            serde_json::from_slice(&prepared.body).expect("OpenAI body should be JSON");
        assert!(value.get("top_p").is_none());
        ollama_request.top_p = None;
        let prepared = prepare_generation(&ollama_request)
            .await
            .expect("Ollama default sampling should prepare");
        let value: serde_json::Value =
            serde_json::from_slice(&prepared.body).expect("Ollama body should be JSON");
        assert!(value["options"].get("top_p").is_none());

        let mut provider_request = generation_request();
        provider_request.temperature = None;
        provider_request.top_p = Some(0.5);
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
        assert_eq!(value["top_p"], 0.5);
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
        assert_eq!(value["generationConfig"]["topP"], 0.5);

        provider_request.top_p = None;
        let anthropic = build_anthropic_generation_body(&provider_request)
            .expect("Anthropic default sampling should remain expressible");
        let value = serde_json::to_value(anthropic).expect("Anthropic body should serialize");
        assert!(value.get("top_p").is_none());
        let gemini = build_gemini_generation_body(&provider_request)
            .expect("Gemini default sampling should remain expressible");
        let value = serde_json::to_value(gemini).expect("Gemini body should serialize");
        assert!(value["generationConfig"].get("topP").is_none());

        provider_request.messages.swap(0, 1);
        assert!(build_anthropic_generation_body(&provider_request).is_err());
        assert!(build_gemini_generation_body(&provider_request).is_err());
    }

    #[tokio::test]
    async fn conditionally_disables_openai_compatible_reasoning_without_affecting_other_requests() {
        let mut request = generation_request();
        request.reasoning_mode = Some(ReasoningMode::Disabled);
        let prepared = prepare_generation(&request)
            .await
            .expect("OpenAI-compatible reasoning control should prepare");
        let value: serde_json::Value =
            serde_json::from_slice(&prepared.body).expect("prepared body should be JSON");
        assert_eq!(value["thinking"]["type"], "disabled");

        request.response_format = Some(ResponseFormat::JsonObject);
        let prepared = prepare_generation(&request)
            .await
            .expect("OpenAI-compatible JSON mode should prepare");
        let value: serde_json::Value =
            serde_json::from_slice(&prepared.body).expect("prepared body should be JSON");
        assert_eq!(value["response_format"]["type"], "json_object");

        request.reasoning_mode = None;
        request.response_format = None;
        let prepared = prepare_generation(&request)
            .await
            .expect("default OpenAI-compatible request should prepare");
        let value: serde_json::Value =
            serde_json::from_slice(&prepared.body).expect("prepared body should be JSON");
        assert!(value.get("thinking").is_none());

        request.reasoning_mode = Some(ReasoningMode::Disabled);
        request.config.provider = ProviderKind::Ollama;
        request.config.base_url = "http://127.0.0.1:11434".to_owned();
        assert_eq!(
            prepare_generation(&request)
                .await
                .err()
                .expect("unsupported protocols must not silently ignore reasoning mode")
                .code(),
            "MODEL_OPERATION_UNSUPPORTED"
        );

        request.reasoning_mode = None;
        request.response_format = Some(ResponseFormat::JsonObject);
        assert_eq!(
            prepare_generation(&request)
                .await
                .err()
                .expect("unsupported protocols must not silently ignore JSON mode")
                .code(),
            "MODEL_OPERATION_UNSUPPORTED"
        );
    }

    #[tokio::test]
    async fn distinguishes_json_completion_from_sse_and_keeps_usage() {
        let server = spawn_fake_server(
            "200 OK",
            br#"{"choices":[{"message":{"content":"Visible"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#,
            Duration::ZERO,
            None,
        );
        let mut request = generation_request();
        request.config.base_url = format!("{}/v1", server.base_url);
        let prepared = prepare_generation(&request)
            .await
            .expect("prepare JSON request");

        #[derive(Default)]
        struct RecordingSink(String);
        impl GenerationDeltaSink for RecordingSink {
            fn emit_delta(&mut self, delta: &str) -> Result<(), CommandError> {
                self.0.push_str(delta);
                Ok(())
            }
        }
        let mut sink = RecordingSink::default();
        let outcome = stream_generation(
            &test_client(),
            prepared,
            &CancellationToken::new(),
            &mut sink,
        )
        .await
        .expect("JSON completion should succeed");
        assert_eq!(sink.0, "Visible");
        assert!(matches!(
            outcome,
            RunOutcome::Completed {
                streamed: false,
                usage: Some(GenerationUsage {
                    input_tokens: 3,
                    output_tokens: 2,
                    cached_input_tokens: None,
                }),
            }
        ));
        let _ = server
            .request
            .recv_timeout(Duration::from_secs(1))
            .expect("generation request should arrive");
        server.handle.join().expect("fake server should stop");
    }

    #[tokio::test]
    async fn truncation_keeps_same_frame_visible_delta_usage_and_redacted_observations() {
        let server = spawn_fake_server(
            "200 OK",
            b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"private\",\"content\":\"partial\"},\"finish_reason\":\"length\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":8}}\n\n",
            Duration::ZERO,
            None,
        );
        let mut request = generation_request();
        request.config.base_url = format!("{}/v1", server.base_url);
        let prepared = prepare_generation(&request)
            .await
            .expect("prepare SSE request");

        #[derive(Default)]
        struct RecordingSink(String);
        impl GenerationDeltaSink for RecordingSink {
            fn emit_delta(&mut self, delta: &str) -> Result<(), CommandError> {
                self.0.push_str(delta);
                Ok(())
            }
        }
        let mut sink = RecordingSink::default();
        let error = stream_generation(
            &test_client(),
            prepared,
            &CancellationToken::new(),
            &mut sink,
        )
        .await
        .err()
        .expect("length finish reason must remain a strict failure");
        assert_eq!(sink.0, "partial");
        assert_eq!(error.code(), "MODEL_OUTPUT_TRUNCATED");
        assert_eq!(error.http_status(), Some(200));
        assert_eq!(error.finish_reason(), Some("length"));
        assert_eq!(error.reasoning_present(), Some(true));
        assert_eq!(error.reasoning_length(), Some(7));
        assert_eq!(error.stream(), Some(true));
        assert_eq!(
            error.usage(),
            Some(&GenerationUsage {
                input_tokens: 3,
                output_tokens: 8,
                cached_input_tokens: None,
            })
        );
        assert!(!serde_json::to_string(&error)
            .expect("error should serialize")
            .contains("private"));
        let _ = server
            .request
            .recv_timeout(Duration::from_secs(1))
            .expect("generation request should arrive");
        server.handle.join().expect("fake server should stop");
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
    async fn native_embedding_writes_one_content_free_receipt_before_provider_io() {
        const INVOCATION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000605";
        let server = spawn_fake_server(
            "200 OK",
            br#"{"data":[{"index":0,"embedding":[0.25,0.75]}],"model":"embed-1"}"#,
            Duration::ZERO,
            None,
        );
        let (directory, sqlite, request) = seeded_non_project_embedding_invocation(
            "success",
            &server.base_url,
            30_000,
            INVOCATION_ID,
        )
        .await;
        let gateway = ModelGatewayState::new().expect("build embedding gateway");

        let response = embed_native_model_inner(&gateway, &sqlite, request)
            .await
            .expect("native embedding succeeds after durable receipt");
        let receipt = response
            .invocation_dispatch_receipt
            .as_ref()
            .expect("successful native embedding returns its receipt");
        assert_eq!(receipt.invocation_id, INVOCATION_ID);
        assert_eq!(receipt.revision, 2);
        assert_eq!(response.vector_count, 1);
        assert_eq!(response.dimension, 2);
        let wire_request = server
            .request
            .recv_timeout(Duration::from_secs(1))
            .expect("provider receives the single fenced embedding request");
        assert!(String::from_utf8(wire_request)
            .expect("wire request is UTF-8")
            .starts_with("POST /v1/embeddings HTTP/1.1\r\n"));
        assert!(
            server.request.try_recv().is_err(),
            "automatic retry remains zero"
        );
        server.handle.join().expect("fake server stops");

        let mut inspector = open_dispatch_inspector(&directory.join("inkshadow.db")).await;
        let persisted: (
            Option<String>,
            i64,
            Option<i64>,
            Option<i64>,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT provider_dispatch_started_at, revision,
                        input_tokens, output_tokens, error_summary
                 FROM model_invocation_facts WHERE id = ?",
        )
        .bind(INVOCATION_ID)
        .fetch_one(&mut inspector)
        .await
        .expect("inspect content-free embedding receipt");
        assert_eq!(persisted.0.as_deref(), Some(receipt.dispatched_at.as_str()));
        assert_eq!(persisted.1, 2);
        assert_eq!((persisted.2, persisted.3, persisted.4), (None, None, None));
        drop(inspector);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn native_embedding_timeout_keeps_one_receipt_and_never_resends() {
        const INVOCATION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000606";
        let server = spawn_fake_server(
            "200 OK",
            br#"{"data":[{"index":0,"embedding":[0.25,0.75]}],"model":"embed-1"}"#,
            Duration::from_millis(1_200),
            None,
        );
        let (directory, sqlite, request) = seeded_non_project_embedding_invocation(
            "timeout",
            &server.base_url,
            1_000,
            INVOCATION_ID,
        )
        .await;
        let gateway = ModelGatewayState::new().expect("build embedding gateway");

        let error = embed_native_model_inner(&gateway, &sqlite, request)
            .await
            .expect_err("provider response after the deadline stays unresolved");
        assert_eq!(error.code(), "MODEL_TIMEOUT");
        server
            .request
            .recv_timeout(Duration::from_secs(1))
            .expect("provider receives exactly one request before timeout");
        assert!(
            server.request.try_recv().is_err(),
            "automatic retry remains zero"
        );
        server.handle.join().expect("slow fake server stops");

        let mut inspector = open_dispatch_inspector(&directory.join("inkshadow.db")).await;
        let persisted: (Option<String>, i64, String) = sqlx::query_as(
            "SELECT provider_dispatch_started_at, revision, status
             FROM model_invocation_facts WHERE id = ?",
        )
        .bind(INVOCATION_ID)
        .fetch_one(&mut inspector)
        .await
        .expect("inspect receipt after provider timeout");
        assert!(persisted.0.is_some(), "dispatch receipt remains durable");
        assert_eq!(persisted.1, 2);
        assert_eq!(persisted.2, "running");
        drop(inspector);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn delayed_remote_embedding_holds_the_barrier_until_the_network_future_ends() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000071";
        let directory = std::env::temp_dir().join(format!(
            "inkshadow-gateway-dispatch-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir(&directory).expect("create test directory");
        let database_path = directory.join("inkshadow.db");
        let sqlite = Arc::new(NativeSqliteState::default());
        sqlite
            .test_open_migrated_database(&database_path)
            .await
            .expect("open migrated native database");
        sqlite
            .test_execute_internal_sql(&format!(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES \
                 ('{PROJECT_ID}', 'Delayed request', '2026-08-08T00:00:00.000Z', \
                 '2026-08-08T00:00:00.000Z')"
            ))
            .await
            .expect("seed empty project");
        let mut receipt = NativeProjectContextPrivacyReceipt {
            schema_version: 1,
            project_id: PROJECT_ID.to_owned(),
            fingerprint: String::new(),
            active_chapter_count: 0,
            retained_chapter_count: 0,
            requires_verified_local: false,
            chapters: vec![],
        };
        receipt.fingerprint = canonical_project_context_fingerprint(&receipt)
            .expect("canonical empty-project fingerprint");
        let scope = NativeModelDispatchScope::ProjectContext { receipt };
        let server = spawn_gated_fake_server(
            "200 OK",
            br#"{"data":[{"index":0,"embedding":[0.25,0.75]}],"model":"embed-1"}"#,
        );
        let request = embedding_request(
            format!("{}/v1", server.base_url),
            ProviderKind::OpenAiCompatible,
            "embed-1",
            &["project context"],
        );
        let mut prepared = prepare_embedding(&request)
            .await
            .expect("prepare embedding");
        // The fake HTTP endpoint is loopback, but the lifecycle under test is
        // the remote branch whose complete future must be fenced by SQLite.
        prepared.endpoint_is_loopback = false;
        let gateway = Arc::new(ModelGatewayState::new().expect("gateway state"));
        let worker_gateway = Arc::clone(&gateway);
        let worker_sqlite = Arc::clone(&sqlite);
        let worker = tokio::spawn(async move {
            run_prepared_embedding_with_dispatch(
                &worker_gateway,
                &worker_sqlite,
                &scope,
                Duration::from_secs(5),
                prepared,
                "delayed-embedding".to_owned(),
            )
            .await
        });

        let mut writer = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(false)
                .foreign_keys(true)
                .journal_mode(SqliteJournalMode::Wal)
                .busy_timeout(Duration::from_secs(1)),
        )
        .await
        .expect("open independent writer");
        for _ in 0..50 {
            let count =
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM project_remote_dispatch_leases")
                    .fetch_one(&mut writer)
                    .await
                    .expect("observe lease count");
            if count == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM project_remote_dispatch_leases",)
                .fetch_one(&mut writer)
                .await
                .expect("lease committed before request"),
            1
        );
        let blocked = sqlx::query(
            "INSERT INTO chapters (
               id, project_id, title, content, current_version_id, created_at, updated_at,
               privacy_mode, privacy_revision
             ) VALUES (
               '019f9f4a-b3c7-7350-9226-000000000072', ?, 'Private', '',
               '019f9f4a-b3c7-7350-9226-000000000073',
               '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', 'local_only', 1
             )",
        )
        .bind(PROJECT_ID)
        .execute(&mut writer)
        .await
        .expect_err("privacy-tainting write must wait for delayed response");
        assert!(blocked
            .as_database_error()
            .is_some_and(|error| error.message().contains("INKSHADOW_REMOTE_DISPATCH_ACTIVE")));

        server
            .release
            .send(())
            .expect("release delayed embedding response");
        let response = worker
            .await
            .expect("gateway worker joins")
            .expect("delayed response succeeds");
        assert_eq!(response.vector_count, 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM project_remote_dispatch_leases",)
                .fetch_one(&mut writer)
                .await
                .expect("lease released after response future"),
            0
        );
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("dispatch registry snapshot")
            .is_empty());
        server.handle.join().expect("fake server stops");
        drop(writer);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn delayed_loopback_project_dispatch_holds_the_same_project_lifecycle_barrier() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000081";
        let (directory, sqlite, scope) =
            seeded_empty_remote_project("loopback-project-barrier", PROJECT_ID).await;
        let server = spawn_gated_fake_server(
            "200 OK",
            br#"{"data":[{"index":0,"embedding":[0.5,0.5]}],"model":"embed-local"}"#,
        );
        let request = embedding_request(
            format!("{}/v1", server.base_url),
            ProviderKind::OpenAiCompatible,
            "embed-local",
            &["local project context"],
        );
        let prepared = prepare_embedding(&request)
            .await
            .expect("prepare loopback embedding");
        assert!(prepared.endpoint_is_loopback);
        let gateway = Arc::new(ModelGatewayState::new().expect("gateway state"));
        let worker_gateway = Arc::clone(&gateway);
        let worker_sqlite = Arc::clone(&sqlite);
        let worker = tokio::spawn(async move {
            run_prepared_embedding_with_dispatch(
                &worker_gateway,
                &worker_sqlite,
                &scope,
                Duration::from_secs(5),
                prepared,
                "delayed-loopback-embedding".to_owned(),
            )
            .await
        });

        let mut writer = open_dispatch_inspector(&directory.join("inkshadow.db")).await;
        wait_for_dispatch_lease_count(&mut writer, 1).await;
        let archive = sqlx::query(
            "UPDATE projects
             SET status = 'archived', archived_at = '2026-08-08T00:01:00.000Z'
             WHERE id = ?",
        )
        .bind(PROJECT_ID)
        .execute(&mut writer)
        .await
        .expect_err("loopback project dispatch must also delay project archive");
        assert!(archive
            .as_database_error()
            .is_some_and(|error| error.message().contains("INKSHADOW_REMOTE_DISPATCH_ACTIVE")));

        server
            .release
            .send(())
            .expect("release delayed loopback response");
        let response = worker
            .await
            .expect("loopback gateway worker joins")
            .expect("loopback response succeeds");
        assert_eq!(response.vector_count, 1);
        wait_for_dispatch_lease_count(&mut writer, 0).await;
        sqlx::query(
            "UPDATE projects
             SET status = 'archived', archived_at = '2026-08-08T00:01:00.000Z'
             WHERE id = ?",
        )
        .bind(PROJECT_ID)
        .execute(&mut writer)
        .await
        .expect("project archive succeeds once the loopback future ends");
        server.handle.join().expect("fake server stops");
        drop(writer);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn reconciliation_snapshot_and_new_acquisition_are_one_atomic_lifecycle() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000091";
        let (directory, sqlite, scope) =
            seeded_empty_remote_project("reconcile-barrier", PROJECT_ID).await;
        let receipt = match &scope {
            NativeModelDispatchScope::ProjectContext { receipt } => receipt.clone(),
            NativeModelDispatchScope::NonProject { .. } => unreachable!("project fixture"),
        };
        sqlite
            .acquire_project_remote_dispatch_lease(
                &receipt,
                false,
                "embedding",
                "ended-before-reconcile",
            )
            .await
            .expect("seed a lease absent from the native live registry");

        let gateway = Arc::new(ModelGatewayState::new().expect("gateway state"));
        let (snapshot_ready_tx, snapshot_ready_rx) = tokio::sync::oneshot::channel();
        let (continue_tx, continue_rx) = tokio::sync::oneshot::channel();
        let reconcile_gateway = Arc::clone(&gateway);
        let reconcile_sqlite = Arc::clone(&sqlite);
        let reconcile = tokio::spawn(async move {
            reconcile_remote_dispatch_leases_with_snapshot_pause(
                &reconcile_gateway,
                &reconcile_sqlite,
                async move {
                    snapshot_ready_tx
                        .send(())
                        .expect("signal captured registry snapshot");
                    continue_rx.await.expect("release snapshot barrier");
                },
            )
            .await
        });
        snapshot_ready_rx
            .await
            .expect("reconciliation reaches old-snapshot window");

        let acquire_gateway = Arc::clone(&gateway);
        let acquire_sqlite = Arc::clone(&sqlite);
        let acquire = tokio::spawn(async move {
            begin_remote_dispatch(
                &acquire_gateway,
                &acquire_sqlite,
                &scope,
                false,
                "rerank",
                "starts-during-reconcile",
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            !acquire.is_finished(),
            "new acquisition must wait outside the captured-snapshot window"
        );
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("snapshot native registry while reconciliation is paused")
            .is_empty());

        continue_tx
            .send(())
            .expect("let reconciliation commit cleanup");
        assert_eq!(
            reconcile
                .await
                .expect("reconciliation worker joins")
                .expect("reconciliation succeeds"),
            1
        );
        let lease = acquire
            .await
            .expect("acquisition worker joins")
            .expect("new acquisition succeeds after reconciliation");
        let mut inspector = open_dispatch_inspector(&directory.join("inkshadow.db")).await;
        assert_eq!(dispatch_lease_count(&mut inspector).await, 1);
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("snapshot registry after acquisition")
            .contains("starts-during-reconcile"));

        finish_remote_dispatch(
            &gateway.dispatch_lifecycle,
            &gateway.dispatch_registry,
            &sqlite,
            lease,
            "starts-during-reconcile",
        )
        .await
        .expect("finish new dispatch");
        assert_eq!(dispatch_lease_count(&mut inspector).await, 0);
        drop(inspector);
        drop(gateway);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn dropping_embedding_command_future_does_not_release_a_live_network_lease() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000101";
        let (directory, sqlite, scope) =
            seeded_empty_remote_project("embedding-drop", PROJECT_ID).await;
        let server = spawn_gated_fake_server(
            "200 OK",
            br#"{"data":[{"index":0,"embedding":[0.25,0.75]}],"model":"embed-1"}"#,
        );
        let request = embedding_request(
            format!("{}/v1", server.base_url),
            ProviderKind::OpenAiCompatible,
            "embed-1",
            &["project context"],
        );
        let mut prepared = prepare_embedding(&request)
            .await
            .expect("prepare embedding");
        prepared.endpoint_is_loopback = false;
        let gateway = Arc::new(ModelGatewayState::new().expect("gateway state"));
        let outer_gateway = Arc::clone(&gateway);
        let outer_sqlite = Arc::clone(&sqlite);
        let outer = tokio::spawn(async move {
            run_prepared_embedding_with_dispatch(
                &outer_gateway,
                &outer_sqlite,
                &scope,
                Duration::from_secs(5),
                prepared,
                "dropped-embedding-command".to_owned(),
            )
            .await
        });
        let mut inspector = open_dispatch_inspector(&directory.join("inkshadow.db")).await;
        wait_for_dispatch_lease_count(&mut inspector, 1).await;
        tokio::time::sleep(Duration::from_millis(30)).await;

        outer.abort();
        assert!(outer
            .await
            .expect_err("outer invoke future is cancelled")
            .is_cancelled());
        assert_eq!(dispatch_lease_count(&mut inspector).await, 1);
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("registry remains live after outer cancellation")
            .contains("dropped-embedding-command"));

        server
            .release
            .send(())
            .expect("release detached embedding response");
        wait_for_dispatch_lease_count(&mut inspector, 0).await;
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("registry after detached worker finishes")
            .is_empty());
        server.handle.join().expect("fake server stops");
        drop(inspector);
        drop(gateway);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn dropping_embedding_command_while_begin_is_blocked_keeps_native_lifecycle_alive() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000131";
        const OPERATION_ID: &str = "embedding-cancelled-during-begin";
        let (directory, sqlite, scope) =
            seeded_empty_remote_project("embedding-begin-drop", PROJECT_ID).await;
        let server = spawn_gated_fake_server(
            "200 OK",
            br#"{"data":[{"index":0,"embedding":[0.25,0.75]}],"model":"embed-1"}"#,
        );
        let request = embedding_request(
            format!("{}/v1", server.base_url),
            ProviderKind::OpenAiCompatible,
            "embed-1",
            &["project context"],
        );
        let mut prepared = prepare_embedding(&request)
            .await
            .expect("prepare embedding");
        prepared.endpoint_is_loopback = false;
        let gateway = Arc::new(ModelGatewayState::new().expect("gateway state"));
        let mut writer = open_dispatch_inspector(&directory.join("inkshadow.db")).await;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut writer)
            .await
            .expect("hold the acquisition writer barrier");

        let outer_gateway = Arc::clone(&gateway);
        let outer_sqlite = Arc::clone(&sqlite);
        let outer = tokio::spawn(async move {
            run_prepared_embedding_with_dispatch(
                &outer_gateway,
                &outer_sqlite,
                &scope,
                Duration::from_secs(5),
                prepared,
                OPERATION_ID.to_owned(),
            )
            .await
        });
        wait_for_dispatch_registry_entry(&gateway, OPERATION_ID).await;
        assert_eq!(dispatch_lease_count(&mut writer).await, 0);

        outer.abort();
        assert!(outer
            .await
            .expect_err("outer invoke future is cancelled during begin")
            .is_cancelled());
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("native worker remains registered during begin")
            .contains(OPERATION_ID));

        sqlx::query("COMMIT")
            .execute(&mut writer)
            .await
            .expect("release the acquisition writer barrier");
        wait_for_dispatch_lease_count(&mut writer, 1).await;
        server
            .release
            .send(())
            .expect("release embedding response after begin completes");
        wait_for_dispatch_lease_count(&mut writer, 0).await;
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("registry after begin-cancelled embedding finishes")
            .is_empty());
        server.handle.join().expect("fake server stops");
        drop(writer);
        drop(gateway);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn generation_cancellation_releases_the_lease_before_terminal_status() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000081";
        let directory = std::env::temp_dir().join(format!(
            "inkshadow-generation-cancel-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir(&directory).expect("create test directory");
        let database_path = directory.join("inkshadow.db");
        let sqlite = NativeSqliteState::default();
        sqlite
            .test_open_migrated_database(&database_path)
            .await
            .expect("open migrated database");
        sqlite
            .test_execute_internal_sql(&format!(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES \
                 ('{PROJECT_ID}', 'Cancellation', '2026-08-08T00:00:00.000Z', \
                 '2026-08-08T00:00:00.000Z')"
            ))
            .await
            .expect("seed project");
        let mut receipt = NativeProjectContextPrivacyReceipt {
            schema_version: 1,
            project_id: PROJECT_ID.to_owned(),
            fingerprint: String::new(),
            active_chapter_count: 0,
            retained_chapter_count: 0,
            requires_verified_local: false,
            chapters: vec![],
        };
        receipt.fingerprint =
            canonical_project_context_fingerprint(&receipt).expect("canonical privacy fingerprint");
        let scope = NativeModelDispatchScope::ProjectContext { receipt };
        let server = spawn_fake_server(
            "200 OK",
            b"data: [DONE]\n\n",
            Duration::from_millis(300),
            None,
        );
        let mut request = generation_request();
        request.config.base_url = format!("{}/v1", server.base_url);
        request.config.request_timeout_ms = Some(2_000);
        let mut prepared = prepare_generation(&request)
            .await
            .expect("prepare generation");
        prepared.endpoint_is_loopback = false;
        let gateway = ModelGatewayState::new().expect("gateway state");
        let operation_id = "cancelled-generation";
        let lease =
            begin_remote_dispatch(&gateway, &sqlite, &scope, false, "generation", operation_id)
                .await
                .expect("acquire remote generation lease");
        let cancellation = CancellationToken::new();
        let cancel = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            cancel.cancel();
        });
        #[derive(Default)]
        struct TestSink;
        impl GenerationDeltaSink for TestSink {
            fn emit_delta(&mut self, _delta: &str) -> Result<(), CommandError> {
                Ok(())
            }
        }
        let mut sink = TestSink;
        let result = timeout(
            Duration::from_secs(2),
            stream_generation(&gateway.client, prepared, &cancellation, &mut sink),
        )
        .await;
        let terminal = finalize_generation_dispatch(
            &sqlite,
            lease,
            &gateway.dispatch_registry,
            &gateway.dispatch_lifecycle,
            operation_id,
            result,
        )
        .await;
        assert!(matches!(terminal, GenerationEventStatus::Cancelled));
        let mut writer = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(false)
                .foreign_keys(true)
                .journal_mode(SqliteJournalMode::Wal),
        )
        .await
        .expect("open post-cancel inspection");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM project_remote_dispatch_leases",)
                .fetch_one(&mut writer)
                .await
                .expect("terminal status observes released lease"),
            0
        );
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("registry snapshot")
            .is_empty());
        server.handle.join().expect("fake server stops");
        drop(writer);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn generation_timeout_releases_the_lease_before_terminal_status() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000111";
        let (directory, sqlite, scope) =
            seeded_empty_remote_project("generation-timeout", PROJECT_ID).await;
        let gateway = ModelGatewayState::new().expect("gateway state");
        let operation_id = "timed-out-generation";
        let lease =
            begin_remote_dispatch(&gateway, &sqlite, &scope, false, "generation", operation_id)
                .await
                .expect("acquire generation timeout lease");
        let result = timeout(
            Duration::from_millis(5),
            std::future::pending::<Result<RunOutcome, CommandError>>(),
        )
        .await;
        let terminal = finalize_generation_dispatch(
            &sqlite,
            lease,
            &gateway.dispatch_registry,
            &gateway.dispatch_lifecycle,
            operation_id,
            result,
        )
        .await;
        assert!(matches!(
            terminal,
            GenerationEventStatus::Failed {
                code: "MODEL_TIMEOUT",
                retryable: true,
                ..
            }
        ));
        let mut inspector = open_dispatch_inspector(&directory.join("inkshadow.db")).await;
        assert_eq!(dispatch_lease_count(&mut inspector).await, 0);
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("registry after generation timeout")
            .is_empty());
        drop(inspector);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn book_start_guidance_receipt_is_durable_before_native_provider_io() {
        const INVOCATION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000501";
        const GENERATION_ID: &str = "capability-probe-native-boundary";
        let directory = std::env::temp_dir().join(format!(
            "inkshadow-capability-probe-boundary-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir(&directory).expect("create capability boundary directory");
        let database_path = directory.join("inkshadow.db");
        let sqlite = NativeSqliteState::default();
        sqlite
            .test_open_migrated_database(&database_path)
            .await
            .expect("open migrated capability boundary database");
        sqlite
            .test_execute_internal_sql(
                "INSERT INTO model_provider_connections (
                   id, provider_kind, display_name, protocol, base_url, created_at, updated_at
                 ) VALUES ('native-boundary-connection', 'custom_openai_compatible',
                           'Native boundary', 'openai_compatible',
                           'https://example.test/v1',
                           '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')",
            )
            .await
            .expect("seed native boundary connection");
        sqlite
            .test_execute_internal_sql(
                "INSERT INTO model_catalog_entries (
                   id, connection_id, provider_model_id, display_name, catalog_source,
                   availability, lifecycle, first_discovered_at, last_seen_at
                 ) VALUES ('native-boundary-catalog', 'native-boundary-connection',
                           'model-1', 'model-1', 'manual', 'available', 'stable',
                           '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')",
            )
            .await
            .expect("seed native boundary catalog");
        sqlite
            .test_execute_internal_sql(&format!(
                "INSERT INTO model_invocation_facts (
                   id, task, connection_id, catalog_entry_id,
                   provider_kind_snapshot, model_id_snapshot,
                   route_reason, status, attempt, privacy_policy, data_destination,
                   started_at, created_at, revision
                  ) VALUES ('{INVOCATION_ID}', 'book_start_guidance',
                           'native-boundary-connection', 'native-boundary-catalog',
                           'custom_openai_compatible', 'model-1', 'user_override',
                           'running', 1, 'cloud_allowed', 'remote',
                           '2026-08-21T00:00:00.000Z',
                           '2026-08-21T00:00:00.000Z', 1)"
            ))
            .await
            .expect("seed running book-start invocation");
        let mut stored_request = generation_request();
        stored_request.config.provider_id = "native-boundary-connection".to_owned();
        stored_request.config.base_url = "https://example.test/v1".to_owned();
        stored_request.config.retry_limit = Some(0);
        stored_request.dispatch_scope = NativeModelDispatchScope::NonProject {
            reason: crate::native_sqlite::NativeNonProjectDispatchReason::CreativeOpening,
        };
        let (wrong_identity_ledger, stored_target) = invocation_dispatch_boundary(
            &stored_request,
            INVOCATION_ID,
            "native-boundary-connection",
            1,
            "different-running-probe",
            1,
            "custom_openai_compatible",
        );
        let wrong_identity = sqlite
            .mark_model_invocation_dispatched(&wrong_identity_ledger, &stored_target)
            .await;
        assert_eq!(
            wrong_identity,
            Err(ModelInvocationDispatchLedgerError::Conflict)
        );
        let (mut wrong_task_ledger, wrong_task_target) = invocation_dispatch_boundary(
            &stored_request,
            INVOCATION_ID,
            "native-boundary-connection",
            1,
            "native-boundary-catalog",
            1,
            "custom_openai_compatible",
        );
        wrong_task_ledger.task_snapshot = "continuation".to_owned();
        assert_eq!(
            sqlite
                .mark_model_invocation_dispatched(&wrong_task_ledger, &wrong_task_target)
                .await,
            Err(ModelInvocationDispatchLedgerError::Conflict)
        );
        let mut predispatch_inspector = open_dispatch_inspector(&database_path).await;
        let predispatch: (Option<String>, i64) = sqlx::query_as(
            "SELECT provider_dispatch_started_at, revision
             FROM model_invocation_facts WHERE id = ?",
        )
        .bind(INVOCATION_ID)
        .fetch_one(&mut predispatch_inspector)
        .await
        .expect("wrong identity leaves ledger untouched");
        assert_eq!(predispatch, (None, 1));
        drop(predispatch_inspector);
        let server = spawn_fake_server(
            "200 OK",
            b"data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n",
            Duration::ZERO,
            None,
        );
        let mut request = generation_request();
        request.generation_id = GENERATION_ID.to_owned();
        request.config.provider_id = "native-boundary-connection".to_owned();
        request.config.base_url = format!("{}/v1", server.base_url);
        request.config.retry_limit = Some(0);
        request.dispatch_scope = NativeModelDispatchScope::NonProject {
            reason: crate::native_sqlite::NativeNonProjectDispatchReason::CreativeOpening,
        };
        let prepared = prepare_generation(&request)
            .await
            .expect("prepare fixed capability probe");
        let wrong_identity_prepared = prepare_generation(&request)
            .await
            .expect("prepare identity-mismatch capability probe");

        #[derive(Default)]
        struct TestEventSink;
        impl GenerationDeltaSink for TestEventSink {
            fn emit_delta(&mut self, _delta: &str) -> Result<(), CommandError> {
                Ok(())
            }
        }
        impl GenerationEventSink for TestEventSink {
            fn emit_status(
                &mut self,
                _status: GenerationEventStatus,
                _delta: String,
            ) -> Result<(), CommandError> {
                Ok(())
            }
        }

        let gateway = ModelGatewayState::new().expect("gateway state");
        let wrong_identity_error = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            wrong_identity_prepared,
            format!("{GENERATION_ID}-wrong-identity"),
            TestEventSink,
            Some(invocation_dispatch_boundary(
                &request,
                INVOCATION_ID,
                "native-boundary-connection",
                1,
                "different-running-probe",
                1,
                "custom_openai_compatible",
            )),
        )
        .await
        .expect_err("a different catalog identity must stop before provider I/O");
        assert_eq!(
            wrong_identity_error.code(),
            "MODEL_INVOCATION_DISPATCH_CONFLICT"
        );
        assert!(server
            .request
            .recv_timeout(Duration::from_millis(100))
            .is_err());
        let endpoint_mismatch_error = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            prepared,
            format!("{GENERATION_ID}-endpoint-drift"),
            TestEventSink,
            Some(invocation_dispatch_boundary(
                &request,
                INVOCATION_ID,
                "native-boundary-connection",
                1,
                "native-boundary-catalog",
                1,
                "custom_openai_compatible",
            )),
        )
        .await
        .expect_err("endpoint drift must stop before provider I/O");
        assert_eq!(
            endpoint_mismatch_error.code(),
            "MODEL_INVOCATION_DISPATCH_CONFLICT"
        );
        assert!(server
            .request
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        sqlite
            .test_execute_internal_sql(&format!(
                "UPDATE model_provider_connections
                 SET base_url = '{}', revision = 2
                 WHERE id = 'native-boundary-connection'",
                request.config.base_url
            ))
            .await
            .expect("align authoritative endpoint");
        sqlite
            .test_execute_internal_sql(
                "UPDATE model_provider_connections
                 SET enabled = 0, revision = 3
                 WHERE id = 'native-boundary-connection'",
            )
            .await
            .expect("disable authoritative connection");
        let disabled_error = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            prepare_generation(&request)
                .await
                .expect("prepare disabled-connection drift probe"),
            format!("{GENERATION_ID}-disabled-drift"),
            TestEventSink,
            Some(invocation_dispatch_boundary(
                &request,
                INVOCATION_ID,
                "native-boundary-connection",
                3,
                "native-boundary-catalog",
                1,
                "custom_openai_compatible",
            )),
        )
        .await
        .expect_err("a disabled connection must stop before provider I/O");
        assert_eq!(disabled_error.code(), "MODEL_INVOCATION_DISPATCH_CONFLICT");
        assert!(server
            .request
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        sqlite
            .test_execute_internal_sql(
                "UPDATE model_provider_connections
                 SET enabled = 1,
                     authentication_mode = 'bearer_keyring',
                     credential_ref = 'keyring:model-hub:different-credential-slot',
                     credential_state = 'present',
                     revision = 4
                 WHERE id = 'native-boundary-connection'",
            )
            .await
            .expect("drift authoritative credential slot");
        let credential_error = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            prepare_generation(&request)
                .await
                .expect("prepare credential drift probe"),
            format!("{GENERATION_ID}-credential-drift"),
            TestEventSink,
            Some(invocation_dispatch_boundary(
                &request,
                INVOCATION_ID,
                "native-boundary-connection",
                4,
                "native-boundary-catalog",
                1,
                "custom_openai_compatible",
            )),
        )
        .await
        .expect_err("credential drift must stop before provider I/O");
        assert_eq!(
            credential_error.code(),
            "MODEL_INVOCATION_DISPATCH_CONFLICT"
        );
        assert!(server
            .request
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        sqlite
            .test_execute_internal_sql(
                "UPDATE model_provider_connections
                 SET authentication_mode = 'none',
                     credential_ref = NULL,
                     credential_state = 'missing',
                     text_generation_path = '/different/chat',
                     revision = 5
                 WHERE id = 'native-boundary-connection'",
            )
            .await
            .expect("drift authoritative generation path");
        let path_error = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            prepare_generation(&request)
                .await
                .expect("prepare generation-path drift probe"),
            format!("{GENERATION_ID}-path-drift"),
            TestEventSink,
            Some(invocation_dispatch_boundary(
                &request,
                INVOCATION_ID,
                "native-boundary-connection",
                5,
                "native-boundary-catalog",
                1,
                "custom_openai_compatible",
            )),
        )
        .await
        .expect_err("generation-path drift must stop before provider I/O");
        assert_eq!(path_error.code(), "MODEL_INVOCATION_DISPATCH_CONFLICT");
        assert!(server
            .request
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        sqlite
            .test_execute_internal_sql(
                "UPDATE model_provider_connections
                 SET text_generation_path = NULL, revision = 6
                 WHERE id = 'native-boundary-connection'",
            )
            .await
            .expect("restore authoritative generation path");
        sqlite
            .test_execute_internal_sql(
                "UPDATE model_catalog_entries
                 SET availability = 'unavailable', revision = 2
                 WHERE id = 'native-boundary-catalog'",
            )
            .await
            .expect("drift authoritative catalog availability");
        let catalog_error = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            prepare_generation(&request)
                .await
                .expect("prepare catalog drift probe"),
            format!("{GENERATION_ID}-catalog-drift"),
            TestEventSink,
            Some(invocation_dispatch_boundary(
                &request,
                INVOCATION_ID,
                "native-boundary-connection",
                6,
                "native-boundary-catalog",
                2,
                "custom_openai_compatible",
            )),
        )
        .await
        .expect_err("an unavailable catalog entry must stop before provider I/O");
        assert_eq!(catalog_error.code(), "MODEL_INVOCATION_DISPATCH_CONFLICT");
        assert!(server
            .request
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        sqlite
            .test_execute_internal_sql(
                "UPDATE model_catalog_entries
                 SET availability = 'available', revision = 3
                 WHERE id = 'native-boundary-catalog'",
            )
            .await
            .expect("restore authoritative catalog entry");
        let prepared = prepare_generation(&request)
            .await
            .expect("prepare aligned capability probe");
        let receipt = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            prepared,
            GENERATION_ID.to_owned(),
            TestEventSink,
            Some(invocation_dispatch_boundary(
                &request,
                INVOCATION_ID,
                "native-boundary-connection",
                6,
                "native-boundary-catalog",
                3,
                "custom_openai_compatible",
            )),
        )
        .await
        .expect("native accepts only the exact authoritative endpoint")
        .expect("capability invocation receipt");
        assert_eq!(receipt.invocation_id, INVOCATION_ID);
        assert_eq!(receipt.revision, 2);

        let mut inspector = open_dispatch_inspector(&database_path).await;
        let persisted: (Option<String>, i64) = sqlx::query_as(
            "SELECT provider_dispatch_started_at, revision
             FROM model_invocation_facts WHERE id = ?",
        )
        .bind(INVOCATION_ID)
        .fetch_one(&mut inspector)
        .await
        .expect("inspect native dispatch receipt");
        assert_eq!(persisted.0.as_deref(), Some(receipt.dispatched_at.as_str()));
        assert_eq!(persisted.1, 2);
        server
            .request
            .recv_timeout(Duration::from_secs(2))
            .expect("provider receives exactly the request fenced by the receipt");
        wait_for_generation_registry_absence(&gateway, GENERATION_ID).await;
        server.handle.join().expect("fake server stops");
        drop(inspector);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn project_context_book_start_requires_privacy_task_and_connection_receipts_before_io() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000511";
        const PRIVATE_PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000512";
        const PRIVATE_CHAPTER_ID: &str = "019f9f4a-b3c7-7350-9226-000000000513";
        const PRIVATE_VERSION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000514";
        const INVOCATION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000515";
        const GENERATION_ID: &str = "project-context-book-start-boundary";
        let (directory, sqlite, scope) =
            seeded_empty_remote_project("project-book-start-boundary", PROJECT_ID).await;
        let database_path = directory.join("inkshadow.db");
        let server = spawn_fake_server(
            "200 OK",
            b"data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n",
            Duration::ZERO,
            None,
        );
        sqlite
            .test_execute_internal_sql(&format!(
                "INSERT INTO model_provider_connections (
                   id, provider_kind, display_name, protocol, base_url, created_at, updated_at
                 ) VALUES ('project-book-start-connection', 'custom_openai_compatible',
                           'Project book start', 'openai_compatible', '{}/v1',
                           '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')",
                server.base_url
            ))
            .await
            .expect("seed project book-start connection");
        sqlite
            .test_execute_internal_sql(
                "INSERT INTO model_catalog_entries (
                   id, connection_id, provider_model_id, display_name, catalog_source,
                   availability, lifecycle, first_discovered_at, last_seen_at
                 ) VALUES ('project-book-start-catalog', 'project-book-start-connection',
                           'model-1', 'model-1', 'manual', 'available', 'stable',
                           '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')",
            )
            .await
            .expect("seed project book-start catalog");
        sqlite
            .test_execute_internal_sql(&format!(
                "INSERT INTO model_invocation_facts (
                   id, task, connection_id, catalog_entry_id,
                   provider_kind_snapshot, model_id_snapshot,
                   route_reason, status, attempt, privacy_policy, data_destination,
                   started_at, created_at, revision
                 ) VALUES ('{INVOCATION_ID}', 'book_start_guidance',
                           'project-book-start-connection', 'project-book-start-catalog',
                           'custom_openai_compatible', 'model-1', 'user_override',
                           'running', 1, 'cloud_allowed', 'remote',
                           '2026-08-21T00:00:00.000Z',
                           '2026-08-21T00:00:00.000Z', 1)"
            ))
            .await
            .expect("seed project book-start invocation");

        let mut private_seeder = open_dispatch_inspector(&database_path).await;
        sqlx::query("BEGIN")
            .execute(&mut private_seeder)
            .await
            .expect("begin private project seed");
        sqlx::query(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (?, 'Private opening', '2026-08-21T00:00:00.000Z',
                     '2026-08-21T00:00:00.000Z')",
        )
        .bind(PRIVATE_PROJECT_ID)
        .execute(&mut private_seeder)
        .await
        .expect("seed private project");
        sqlx::query(
            "INSERT INTO chapters (
               id, project_id, title, content, current_version_id,
               created_at, updated_at, privacy_mode, privacy_revision
             ) VALUES (?, ?, 'Private chapter', '', ?,
                       '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
                       'local_only', 1)",
        )
        .bind(PRIVATE_CHAPTER_ID)
        .bind(PRIVATE_PROJECT_ID)
        .bind(PRIVATE_VERSION_ID)
        .execute(&mut private_seeder)
        .await
        .expect("seed private chapter");
        sqlx::query(
            "INSERT INTO chapter_versions (
               id, project_id, chapter_id, sequence, reason, content,
               content_checksum, created_at
             ) VALUES (?, ?, ?, 1, 'created', '', ?, '2026-08-21T00:00:00.000Z')",
        )
        .bind(PRIVATE_VERSION_ID)
        .bind(PRIVATE_PROJECT_ID)
        .bind(PRIVATE_CHAPTER_ID)
        .bind("a".repeat(64))
        .execute(&mut private_seeder)
        .await
        .expect("seed private version");
        sqlx::query("COMMIT")
            .execute(&mut private_seeder)
            .await
            .expect("commit private project seed");
        drop(private_seeder);
        let private_chapter = NativeProjectContextChapterAuthority {
            chapter_id: PRIVATE_CHAPTER_ID.to_owned(),
            current_version_id: PRIVATE_VERSION_ID.to_owned(),
            revision: 1,
            privacy_revision: 1,
            privacy_mode: "local_only".to_owned(),
            status: "active".to_owned(),
        };
        let mut private_receipt = NativeProjectContextPrivacyReceipt {
            schema_version: 1,
            project_id: PRIVATE_PROJECT_ID.to_owned(),
            fingerprint: String::new(),
            active_chapter_count: 1,
            retained_chapter_count: 1,
            requires_verified_local: true,
            chapters: vec![private_chapter],
        };
        private_receipt.fingerprint = canonical_project_context_fingerprint(&private_receipt)
            .expect("canonical private project receipt");
        let private_scope = NativeModelDispatchScope::ProjectContext {
            receipt: private_receipt,
        };

        #[derive(Default)]
        struct TestEventSink;
        impl GenerationDeltaSink for TestEventSink {
            fn emit_delta(&mut self, _delta: &str) -> Result<(), CommandError> {
                Ok(())
            }
        }
        impl GenerationEventSink for TestEventSink {
            fn emit_status(
                &mut self,
                _status: GenerationEventStatus,
                _delta: String,
            ) -> Result<(), CommandError> {
                Ok(())
            }
        }

        let gateway = ModelGatewayState::new().expect("project book-start gateway state");
        let mut request = generation_request();
        request.generation_id = GENERATION_ID.to_owned();
        request.config.provider_id = "project-book-start-connection".to_owned();
        request.config.base_url = format!("{}/v1", server.base_url);
        request.config.retry_limit = Some(0);

        let mut changed_scope = scope.clone();
        let NativeModelDispatchScope::ProjectContext { receipt } = &mut changed_scope else {
            unreachable!("project fixture")
        };
        receipt.fingerprint = "0".repeat(64);
        request.dispatch_scope = changed_scope;
        let mut changed_prepared = prepare_generation(&request)
            .await
            .expect("prepare changed-privacy project opening");
        changed_prepared.endpoint_is_loopback = false;
        let (mut changed_ledger, changed_target) = invocation_dispatch_boundary(
            &request,
            INVOCATION_ID,
            "project-book-start-connection",
            1,
            "project-book-start-catalog",
            1,
            "custom_openai_compatible",
        );
        changed_ledger.task_snapshot = "book_start_guidance".to_owned();
        let changed_error = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            changed_prepared,
            format!("{GENERATION_ID}-privacy-changed"),
            TestEventSink,
            Some((changed_ledger, changed_target)),
        )
        .await
        .expect_err("changed project privacy receipt must stop before provider I/O");
        assert_eq!(changed_error.code(), "PROJECT_CONTEXT_PRIVACY_CHANGED");
        assert!(server
            .request
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        request.dispatch_scope = private_scope;
        let mut private_prepared = prepare_generation(&request)
            .await
            .expect("prepare private project opening");
        private_prepared.endpoint_is_loopback = false;
        let (mut private_ledger, private_target) = invocation_dispatch_boundary(
            &request,
            INVOCATION_ID,
            "project-book-start-connection",
            1,
            "project-book-start-catalog",
            1,
            "custom_openai_compatible",
        );
        private_ledger.task_snapshot = "book_start_guidance".to_owned();
        let private_error = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            private_prepared,
            format!("{GENERATION_ID}-private"),
            TestEventSink,
            Some((private_ledger, private_target)),
        )
        .await
        .expect_err("private project opening must stop before provider I/O");
        assert_eq!(private_error.code(), "PRIVATE_CHAPTER_LOCAL_ONLY");
        assert!(server
            .request
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        request.dispatch_scope = scope.clone();
        let mut wrong_task_prepared = prepare_generation(&request)
            .await
            .expect("prepare wrong-task project opening");
        wrong_task_prepared.endpoint_is_loopback = false;
        let (wrong_task_ledger, wrong_task_target) = invocation_dispatch_boundary(
            &request,
            INVOCATION_ID,
            "project-book-start-connection",
            1,
            "project-book-start-catalog",
            1,
            "custom_openai_compatible",
        );
        let wrong_task_error = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            wrong_task_prepared,
            format!("{GENERATION_ID}-wrong-task"),
            TestEventSink,
            Some((wrong_task_ledger, wrong_task_target)),
        )
        .await
        .expect_err("wrong project opening task must stop before provider I/O");
        assert_eq!(
            wrong_task_error.code(),
            "MODEL_INVOCATION_DISPATCH_CONFLICT"
        );
        assert!(server
            .request
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        let mut connection_drift_prepared = prepare_generation(&request)
            .await
            .expect("prepare connection-drift project opening");
        connection_drift_prepared.endpoint_is_loopback = false;
        let (mut connection_drift_ledger, connection_drift_target) = invocation_dispatch_boundary(
            &request,
            INVOCATION_ID,
            "project-book-start-connection",
            2,
            "project-book-start-catalog",
            1,
            "custom_openai_compatible",
        );
        connection_drift_ledger.task_snapshot = "book_start_guidance".to_owned();
        let connection_drift_error = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            connection_drift_prepared,
            format!("{GENERATION_ID}-connection-drift"),
            TestEventSink,
            Some((connection_drift_ledger, connection_drift_target)),
        )
        .await
        .expect_err("connection drift must stop project opening before provider I/O");
        assert_eq!(
            connection_drift_error.code(),
            "MODEL_INVOCATION_DISPATCH_CONFLICT"
        );
        assert!(server
            .request
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        let mut before_success = open_dispatch_inspector(&database_path).await;
        let predispatch: (Option<String>, i64) = sqlx::query_as(
            "SELECT provider_dispatch_started_at, revision
             FROM model_invocation_facts WHERE id = ?",
        )
        .bind(INVOCATION_ID)
        .fetch_one(&mut before_success)
        .await
        .expect("inspect project opening before successful dispatch");
        assert_eq!(predispatch, (None, 1));
        assert_eq!(dispatch_lease_count(&mut before_success).await, 0);
        drop(before_success);

        let mut prepared = prepare_generation(&request)
            .await
            .expect("prepare aligned project opening");
        prepared.endpoint_is_loopback = false;
        let (mut ledger, target) = invocation_dispatch_boundary(
            &request,
            INVOCATION_ID,
            "project-book-start-connection",
            1,
            "project-book-start-catalog",
            1,
            "custom_openai_compatible",
        );
        ledger.task_snapshot = "book_start_guidance".to_owned();
        let receipt = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            prepared,
            GENERATION_ID.to_owned(),
            TestEventSink,
            Some((ledger, target)),
        )
        .await
        .expect("aligned project opening starts")
        .expect("project opening receives durable invocation receipt");
        assert_eq!(receipt.invocation_id, INVOCATION_ID);
        assert_eq!(receipt.revision, 2);
        // The startup receipt intentionally returns before the background HTTP
        // future. Yield through the registry lifecycle before using the
        // blocking test receiver so a current-thread Tokio test cannot starve it.
        wait_for_generation_registry_absence(&gateway, GENERATION_ID).await;
        server
            .request
            .recv_timeout(Duration::from_secs(2))
            .expect("provider receives exactly one request after both durable receipts");
        let mut inspector = open_dispatch_inspector(&database_path).await;
        let persisted: (Option<String>, i64) = sqlx::query_as(
            "SELECT provider_dispatch_started_at, revision
             FROM model_invocation_facts WHERE id = ?",
        )
        .bind(INVOCATION_ID)
        .fetch_one(&mut inspector)
        .await
        .expect("inspect durable project opening receipt");
        assert_eq!(persisted.0.as_deref(), Some(receipt.dispatched_at.as_str()));
        assert_eq!(persisted.1, 2);
        assert_eq!(dispatch_lease_count(&mut inspector).await, 0);
        server
            .handle
            .join()
            .expect("project opening fake server stops");
        drop(inspector);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn book_start_guidance_ledger_lock_timeout_starts_zero_provider_io() {
        const INVOCATION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000504";
        const GENERATION_ID: &str = "capability-probe-ledger-lock";
        let directory = std::env::temp_dir().join(format!(
            "inkshadow-capability-probe-ledger-lock-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir(&directory).expect("create ledger lock directory");
        let database_path = directory.join("inkshadow.db");
        let sqlite = NativeSqliteState::default()
            .test_with_foreground_operation_timeout(Duration::from_millis(20));
        sqlite
            .test_open_migrated_database(&database_path)
            .await
            .expect("open migrated ledger lock database");
        sqlite
            .test_execute_internal_sql(
                "INSERT INTO model_provider_connections (
                   id, provider_kind, display_name, protocol, base_url, created_at, updated_at
                 ) VALUES ('native-ledger-lock-connection', 'custom_openai_compatible',
                           'Native ledger lock', 'openai_compatible',
                           'https://example.test/v1',
                           '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')",
            )
            .await
            .expect("seed locked boundary connection");
        sqlite
            .test_execute_internal_sql(
                "INSERT INTO model_catalog_entries (
                   id, connection_id, provider_model_id, display_name, catalog_source,
                   availability, lifecycle, first_discovered_at, last_seen_at
                 ) VALUES ('native-ledger-lock-catalog', 'native-ledger-lock-connection',
                           'model-1', 'model-1', 'manual', 'available', 'stable',
                           '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')",
            )
            .await
            .expect("seed locked boundary catalog");
        sqlite
            .test_execute_internal_sql(&format!(
                "INSERT INTO model_invocation_facts (
                   id, task, connection_id, catalog_entry_id,
                   provider_kind_snapshot, model_id_snapshot,
                   route_reason, status, attempt, privacy_policy, data_destination,
                   started_at, created_at, revision
                  ) VALUES ('{INVOCATION_ID}', 'book_start_guidance',
                           'native-ledger-lock-connection', 'native-ledger-lock-catalog',
                           'custom_openai_compatible', 'model-1', 'user_override',
                           'running', 1, 'cloud_allowed', 'remote',
                           '2026-08-21T00:00:00.000Z',
                           '2026-08-21T00:00:00.000Z', 1)"
            ))
            .await
            .expect("seed locked book-start invocation");
        let mut writer = open_dispatch_inspector(&database_path).await;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut writer)
            .await
            .expect("hold capability ledger writer lock");

        let server = spawn_fake_server("200 OK", b"data: [DONE]\n\n", Duration::ZERO, None);
        let mut request = generation_request();
        request.generation_id = GENERATION_ID.to_owned();
        request.config.provider_id = "native-ledger-lock-connection".to_owned();
        request.config.base_url = format!("{}/v1", server.base_url);
        request.config.retry_limit = Some(0);
        request.dispatch_scope = NativeModelDispatchScope::NonProject {
            reason: crate::native_sqlite::NativeNonProjectDispatchReason::CreativeOpening,
        };
        let prepared = prepare_generation(&request)
            .await
            .expect("prepare locked capability probe");

        #[derive(Default)]
        struct TestEventSink;
        impl GenerationDeltaSink for TestEventSink {
            fn emit_delta(&mut self, _delta: &str) -> Result<(), CommandError> {
                Ok(())
            }
        }
        impl GenerationEventSink for TestEventSink {
            fn emit_status(
                &mut self,
                _status: GenerationEventStatus,
                _delta: String,
            ) -> Result<(), CommandError> {
                Ok(())
            }
        }

        let gateway = ModelGatewayState::new().expect("gateway state");
        let error = start_prepared_generation_with_dispatch(
            &gateway,
            &sqlite,
            &request.dispatch_scope,
            prepared,
            GENERATION_ID.to_owned(),
            TestEventSink,
            Some(invocation_dispatch_boundary(
                &request,
                INVOCATION_ID,
                "native-ledger-lock-connection",
                1,
                "native-ledger-lock-catalog",
                1,
                "custom_openai_compatible",
            )),
        )
        .await
        .expect_err("ledger timeout stops before provider I/O");
        assert_eq!(
            error.code(),
            "MODEL_INVOCATION_DISPATCH_LEDGER_OUTCOME_UNKNOWN"
        );
        assert!(server
            .request
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        let mut unblock = std::net::TcpStream::connect(
            server
                .base_url
                .strip_prefix("http://")
                .expect("loopback server origin"),
        )
        .expect("connect only to release the no-I/O test server");
        unblock
            .write_all(
                b"GET /test-cleanup HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n",
            )
            .expect("release fake server accept");
        sqlx::query("ROLLBACK")
            .execute(&mut writer)
            .await
            .expect("release capability ledger writer lock");
        server.handle.join().expect("fake server stops");
        drop(writer);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn dropping_generation_command_while_begin_is_blocked_keeps_native_lifecycle_alive() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000151";
        const GENERATION_ID: &str = "generation-cancelled-during-begin";
        let (directory, sqlite, scope) =
            seeded_empty_remote_project("generation-begin-drop", PROJECT_ID).await;
        let server = spawn_gated_fake_server("200 OK", b"data: [DONE]\n\n");
        let mut request = generation_request();
        request.config.base_url = format!("{}/v1", server.base_url);
        request.config.request_timeout_ms = Some(5_000);
        let mut prepared = prepare_generation(&request)
            .await
            .expect("prepare generation");
        prepared.endpoint_is_loopback = false;

        #[derive(Default)]
        struct TestEventSink;
        impl GenerationDeltaSink for TestEventSink {
            fn emit_delta(&mut self, _delta: &str) -> Result<(), CommandError> {
                Ok(())
            }
        }
        impl GenerationEventSink for TestEventSink {
            fn emit_status(
                &mut self,
                _status: GenerationEventStatus,
                _delta: String,
            ) -> Result<(), CommandError> {
                Ok(())
            }
        }

        let gateway = Arc::new(ModelGatewayState::new().expect("gateway state"));
        let mut writer = open_dispatch_inspector(&directory.join("inkshadow.db")).await;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut writer)
            .await
            .expect("hold the generation acquisition writer barrier");
        let outer_gateway = Arc::clone(&gateway);
        let outer_sqlite = Arc::clone(&sqlite);
        let outer = tokio::spawn(async move {
            start_prepared_generation_with_dispatch(
                &outer_gateway,
                &outer_sqlite,
                &scope,
                prepared,
                GENERATION_ID.to_owned(),
                TestEventSink,
                None,
            )
            .await
        });
        wait_for_dispatch_registry_entry(&gateway, GENERATION_ID).await;
        assert_eq!(dispatch_lease_count(&mut writer).await, 0);

        outer.abort();
        assert!(outer
            .await
            .expect_err("outer generation invoke is cancelled during begin")
            .is_cancelled());
        assert!(gateway
            .registry
            .contains(GENERATION_ID)
            .expect("generation registry remains native-owned"));
        sqlx::query("COMMIT")
            .execute(&mut writer)
            .await
            .expect("release the generation acquisition writer barrier");
        wait_for_dispatch_lease_count(&mut writer, 1).await;
        server
            .release
            .send(())
            .expect("release generation response after begin completes");
        wait_for_dispatch_lease_count(&mut writer, 0).await;
        wait_for_generation_registry_absence(&gateway, GENERATION_ID).await;
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("registry after begin-cancelled generation finishes")
            .is_empty());
        server.handle.join().expect("fake server stops");
        drop(writer);
        drop(gateway);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn generation_stream_panic_still_releases_lease_and_both_registries() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000161";
        const GENERATION_ID: &str = "generation-panics-after-network";
        let (directory, sqlite, scope) =
            seeded_empty_remote_project("generation-panic", PROJECT_ID).await;
        let server = spawn_fake_server(
            "200 OK",
            b"data: {\"choices\":[{\"delta\":{\"content\":\"panic delta\"}}]}\n\ndata: [DONE]\n\n",
            Duration::ZERO,
            None,
        );
        let mut request = generation_request();
        request.config.base_url = format!("{}/v1", server.base_url);
        let mut prepared = prepare_generation(&request)
            .await
            .expect("prepare generation");
        prepared.endpoint_is_loopback = false;
        let gateway = ModelGatewayState::new().expect("gateway state");
        let cancellation = gateway
            .registry
            .register(GENERATION_ID)
            .expect("register generation");
        let lease = begin_remote_dispatch(
            &gateway,
            &sqlite,
            &scope,
            false,
            "generation",
            GENERATION_ID,
        )
        .await
        .expect("acquire generation lease");

        #[derive(Clone)]
        struct PanicSink {
            terminal: Arc<std::sync::Mutex<Vec<GenerationEventStatus>>>,
        }
        impl GenerationDeltaSink for PanicSink {
            fn emit_delta(&mut self, _delta: &str) -> Result<(), CommandError> {
                panic!("deterministic emitter panic");
            }
        }
        impl GenerationEventSink for PanicSink {
            fn emit_status(
                &mut self,
                status: GenerationEventStatus,
                _delta: String,
            ) -> Result<(), CommandError> {
                self.terminal
                    .lock()
                    .expect("record terminal status")
                    .push(status);
                Ok(())
            }
        }
        let terminal = Arc::new(std::sync::Mutex::new(Vec::new()));
        drive_generation(NativeGenerationLifecycle {
            state: gateway.clone(),
            sqlite: (*sqlite).clone(),
            prepared,
            cancellation,
            generation_id: GENERATION_ID.to_owned(),
            emitter: PanicSink {
                terminal: Arc::clone(&terminal),
            },
            lease,
        })
        .await;

        let mut inspector = open_dispatch_inspector(&directory.join("inkshadow.db")).await;
        assert_eq!(dispatch_lease_count(&mut inspector).await, 0);
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("dispatch registry after panic")
            .is_empty());
        assert!(!gateway
            .registry
            .contains(GENERATION_ID)
            .expect("generation registry after panic"));
        assert!(matches!(
            terminal.lock().expect("read terminal status").as_slice(),
            [GenerationEventStatus::Failed {
                code: "MODEL_RUNTIME_FAILED",
                retryable: true,
                ..
            }]
        ));
        server.handle.join().expect("fake server stops");
        drop(inspector);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
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
            endpoint_is_loopback: true,
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
    async fn dropping_rerank_command_future_does_not_release_a_live_network_lease() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000121";
        let (directory, sqlite, scope) =
            seeded_empty_remote_project("rerank-drop", PROJECT_ID).await;
        let server = spawn_gated_fake_server(
            "200 OK",
            br#"{"object":"list","results":[{"index":1,"relevance_score":0.91}],"model":"qwen3-rerank","usage":{"total_tokens":41}}"#,
        );
        let request = rerank_request(format!("{}/compatible-api/v1", server.base_url));
        let prepared = PreparedRerank {
            provider: ProviderKind::OpenAiCompatible,
            protocol: RerankProtocol::QwenOpenAiCompatible,
            endpoint_origin: server.base_url.clone(),
            url: Url::parse(&format!("{}/compatible-api/v1/reranks", server.base_url))
                .expect("test URL parses"),
            credential: None,
            body: serde_json::to_vec(&QwenRerankBody {
                model: &request.model,
                query: &request.query,
                documents: &request.documents,
                top_n: request.top_n,
            })
            .expect("rerank body serializes"),
            model: request.model,
            document_count: request.documents.len(),
            top_n: request.top_n,
            endpoint_is_loopback: false,
        };
        let gateway = Arc::new(ModelGatewayState::new().expect("gateway state"));
        let outer_gateway = Arc::clone(&gateway);
        let outer_sqlite = Arc::clone(&sqlite);
        let outer = tokio::spawn(async move {
            run_prepared_rerank_with_dispatch(
                &outer_gateway,
                &outer_sqlite,
                &scope,
                Duration::from_secs(5),
                prepared,
                "dropped-rerank-command".to_owned(),
            )
            .await
        });
        let mut inspector = open_dispatch_inspector(&directory.join("inkshadow.db")).await;
        wait_for_dispatch_lease_count(&mut inspector, 1).await;
        tokio::time::sleep(Duration::from_millis(30)).await;

        outer.abort();
        assert!(outer
            .await
            .expect_err("outer invoke future is cancelled")
            .is_cancelled());
        assert_eq!(dispatch_lease_count(&mut inspector).await, 1);
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("registry remains live after outer rerank cancellation")
            .contains("dropped-rerank-command"));

        server
            .release
            .send(())
            .expect("release detached rerank response");
        wait_for_dispatch_lease_count(&mut inspector, 0).await;
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("registry after detached rerank worker finishes")
            .is_empty());
        server.handle.join().expect("fake server stops");
        drop(inspector);
        drop(gateway);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn dropping_rerank_command_while_begin_is_blocked_keeps_native_lifecycle_alive() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000141";
        const OPERATION_ID: &str = "rerank-cancelled-during-begin";
        let (directory, sqlite, scope) =
            seeded_empty_remote_project("rerank-begin-drop", PROJECT_ID).await;
        let server = spawn_gated_fake_server(
            "200 OK",
            br#"{"object":"list","results":[{"index":1,"relevance_score":0.91}],"model":"qwen3-rerank","usage":{"total_tokens":41}}"#,
        );
        let request = rerank_request(format!("{}/compatible-api/v1", server.base_url));
        let prepared = PreparedRerank {
            provider: ProviderKind::OpenAiCompatible,
            protocol: RerankProtocol::QwenOpenAiCompatible,
            endpoint_origin: server.base_url.clone(),
            url: Url::parse(&format!("{}/compatible-api/v1/reranks", server.base_url))
                .expect("test URL parses"),
            credential: None,
            body: serde_json::to_vec(&QwenRerankBody {
                model: &request.model,
                query: &request.query,
                documents: &request.documents,
                top_n: request.top_n,
            })
            .expect("rerank body serializes"),
            model: request.model,
            document_count: request.documents.len(),
            top_n: request.top_n,
            endpoint_is_loopback: false,
        };
        let gateway = Arc::new(ModelGatewayState::new().expect("gateway state"));
        let mut writer = open_dispatch_inspector(&directory.join("inkshadow.db")).await;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut writer)
            .await
            .expect("hold the rerank acquisition writer barrier");

        let outer_gateway = Arc::clone(&gateway);
        let outer_sqlite = Arc::clone(&sqlite);
        let outer = tokio::spawn(async move {
            run_prepared_rerank_with_dispatch(
                &outer_gateway,
                &outer_sqlite,
                &scope,
                Duration::from_secs(5),
                prepared,
                OPERATION_ID.to_owned(),
            )
            .await
        });
        wait_for_dispatch_registry_entry(&gateway, OPERATION_ID).await;
        assert_eq!(dispatch_lease_count(&mut writer).await, 0);

        outer.abort();
        assert!(outer
            .await
            .expect_err("outer rerank invoke is cancelled during begin")
            .is_cancelled());
        sqlx::query("COMMIT")
            .execute(&mut writer)
            .await
            .expect("release the rerank acquisition writer barrier");
        wait_for_dispatch_lease_count(&mut writer, 1).await;
        server
            .release
            .send(())
            .expect("release rerank response after begin completes");
        wait_for_dispatch_lease_count(&mut writer, 0).await;
        assert!(gateway
            .dispatch_registry
            .snapshot()
            .expect("registry after begin-cancelled rerank finishes")
            .is_empty());
        server.handle.join().expect("fake server stops");
        drop(writer);
        drop(gateway);
        drop(sqlite);
        let _ = std::fs::remove_dir_all(directory);
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
                dispatch_scope: test_dispatch_scope(),
                config: config.clone(),
                model: embedding_model.clone(),
                inputs: vec![
                    "雾港的钟声在午夜响起。".to_owned(),
                    "The lighthouse keeper found a sealed letter.".to_owned(),
                ],
                invocation_dispatch_ledger: None,
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
            dispatch_scope: test_dispatch_scope(),
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
            top_p: None,
            reasoning_mode: None,
            response_format: None,
            invocation_dispatch_ledger: None,
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
                    StreamItem::Reasoning { .. } | StreamItem::FinishReason(_) => {}
                    StreamItem::Usage(next) => usage = Some(next),
                    StreamItem::Done => done = true,
                }
            }
        }
        for item in parser.finish().expect("finish real Ollama NDJSON") {
            match item {
                StreamItem::Delta(delta) => output.push_str(&delta),
                StreamItem::Reasoning { .. } | StreamItem::FinishReason(_) => {}
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
