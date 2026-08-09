use serde::{Deserialize, Serialize};

use crate::native_sqlite::NativeModelDispatchScope;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProviderKind {
    OpenAiCompatible,
    Ollama,
    Anthropic,
    Gemini,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AuthenticationMode {
    None,
    BearerKeyring,
    CustomHeaderKeyring,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelEndpointConfig {
    pub(crate) provider_id: String,
    pub(crate) provider: ProviderKind,
    pub(crate) base_url: String,
    pub(crate) authentication: AuthenticationMode,
    #[serde(default)]
    pub(crate) credential_header_name: Option<String>,
    #[serde(default)]
    pub(crate) model_discovery_path: Option<String>,
    #[serde(default)]
    pub(crate) text_generation_path: Option<String>,
    #[serde(default)]
    pub(crate) embedding_path: Option<String>,
    #[serde(default)]
    pub(crate) request_timeout_ms: Option<u64>,
    #[serde(default)]
    pub(crate) retry_limit: Option<u8>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListModelsRequest {
    pub(crate) config: ModelEndpointConfig,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectionCheckRequest {
    pub(crate) config: ModelEndpointConfig,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EmbeddingRequest {
    pub(crate) config: ModelEndpointConfig,
    pub(crate) model: String,
    pub(crate) inputs: Vec<String>,
    pub(crate) dispatch_scope: NativeModelDispatchScope,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RerankProtocol {
    QwenOpenAiCompatible,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RerankRequest {
    pub(crate) config: ModelEndpointConfig,
    pub(crate) protocol: RerankProtocol,
    pub(crate) model: String,
    pub(crate) query: String,
    pub(crate) documents: Vec<String>,
    pub(crate) top_n: usize,
    pub(crate) dispatch_scope: NativeModelDispatchScope,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ModelMessageRole {
    System,
    User,
    Assistant,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReasoningMode {
    Disabled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelMessage {
    pub(crate) role: ModelMessageRole,
    pub(crate) content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartGenerationRequest {
    pub(crate) generation_id: String,
    pub(crate) config: ModelEndpointConfig,
    pub(crate) model: String,
    pub(crate) messages: Vec<ModelMessage>,
    pub(crate) max_output_tokens: u32,
    pub(crate) temperature: Option<f32>,
    #[serde(default)]
    pub(crate) reasoning_mode: Option<ReasoningMode>,
    pub(crate) dispatch_scope: NativeModelDispatchScope,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelGenerationRequest {
    pub(crate) generation_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelDescriptor {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) size_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelListResponse {
    pub(crate) provider: ProviderKind,
    pub(crate) models: Vec<ModelDescriptor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionCheckResponse {
    pub(crate) provider: ProviderKind,
    pub(crate) endpoint_origin: String,
    pub(crate) model_count: usize,
    pub(crate) latency_ms: u128,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddingResponse {
    pub(crate) provider: ProviderKind,
    pub(crate) endpoint_origin: String,
    pub(crate) model: String,
    pub(crate) dimension: usize,
    pub(crate) vector_count: usize,
    pub(crate) embeddings: Vec<Vec<f32>>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RerankScore {
    pub(crate) index: usize,
    pub(crate) relevance_score: f64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RerankResponse {
    pub(crate) provider: ProviderKind,
    pub(crate) protocol: RerankProtocol,
    pub(crate) endpoint_origin: String,
    pub(crate) model: String,
    pub(crate) rankings: Vec<RerankScore>,
    pub(crate) input_tokens: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationAccepted {
    pub(crate) generation_id: String,
    pub(crate) accepted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelGenerationResponse {
    pub(crate) generation_id: String,
    pub(crate) cancellation_requested: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationUsage {
    pub(crate) input_tokens: u32,
    pub(crate) output_tokens: u32,
    pub(crate) cached_input_tokens: Option<u32>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum GenerationEventStatus {
    Started,
    Delta,
    Completed {
        usage: Option<GenerationUsage>,
        streamed: bool,
    },
    Cancelled,
    Failed {
        code: &'static str,
        retryable: bool,
        request_id: String,
        http_status: Option<u16>,
        finish_reason: Option<String>,
        reasoning_present: Option<bool>,
        reasoning_length: Option<u64>,
        stream: Option<bool>,
        usage: Option<GenerationUsage>,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationEvent {
    pub(crate) generation_id: String,
    pub(crate) sequence: u64,
    pub(crate) delta: String,
    pub(crate) status: GenerationEventStatus,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_events_expose_only_the_safe_stream_contract() {
        let event = GenerationEvent {
            generation_id: "generation-1".to_owned(),
            sequence: 7,
            delta: "candidate text".to_owned(),
            status: GenerationEventStatus::Delta,
        };
        let value = serde_json::to_value(event).expect("event should serialize");
        let object = value.as_object().expect("event should be an object");

        assert_eq!(object.len(), 4);
        assert!(object.contains_key("generationId"));
        assert!(object.contains_key("sequence"));
        assert!(object.contains_key("delta"));
        assert!(object.contains_key("status"));
        assert!(!value.to_string().contains("prompt"));
        assert!(!value.to_string().contains("secret"));
    }

    #[test]
    fn provider_protocol_names_are_stable_for_the_frontend_contract() {
        assert_eq!(
            serde_json::to_string(&ProviderKind::Anthropic).expect("serialize Anthropic"),
            "\"anthropic\""
        );
        assert_eq!(
            serde_json::to_string(&ProviderKind::Gemini).expect("serialize Gemini"),
            "\"gemini\""
        );
    }

    #[test]
    fn generation_terminal_events_expose_only_flat_redacted_observations() {
        let event = GenerationEvent {
            generation_id: "generation-1".to_owned(),
            sequence: 8,
            delta: String::new(),
            status: GenerationEventStatus::Failed {
                code: "MODEL_OUTPUT_TRUNCATED",
                retryable: false,
                request_id: "request-1".to_owned(),
                http_status: Some(200),
                finish_reason: Some("length".to_owned()),
                reasoning_present: Some(true),
                reasoning_length: Some(24),
                stream: Some(true),
                usage: Some(GenerationUsage {
                    input_tokens: 9,
                    output_tokens: 8,
                    cached_input_tokens: None,
                }),
            },
        };
        let value = serde_json::to_value(event).expect("event should serialize");
        let status = value["status"].as_object().expect("status object");
        assert_eq!(status["requestId"], "request-1");
        assert_eq!(status["httpStatus"], 200);
        assert_eq!(status["finishReason"], "length");
        assert_eq!(status["reasoningPresent"], true);
        assert_eq!(status["reasoningLength"], 24);
        assert_eq!(status["stream"], true);
        assert_eq!(status["usage"]["outputTokens"], 8);
        let serialized = value.to_string();
        assert!(!serialized.contains("private chain"));
        assert!(!serialized.contains("prompt"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn rerank_response_contract_cannot_echo_query_documents_or_credentials() {
        let response = RerankResponse {
            provider: ProviderKind::OpenAiCompatible,
            protocol: RerankProtocol::QwenOpenAiCompatible,
            endpoint_origin: "https://workspace.cn-beijing.maas.aliyuncs.com".to_owned(),
            model: "qwen3-rerank".to_owned(),
            rankings: vec![RerankScore {
                index: 1,
                relevance_score: 0.8,
            }],
            input_tokens: Some(10),
        };
        let value = serde_json::to_value(response).expect("rerank response should serialize");
        let serialized = value.to_string();
        assert!(!serialized.contains("query"));
        assert!(!serialized.contains("document"));
        assert!(!serialized.contains("credential"));
        assert!(!serialized.contains("secret"));
    }
}
