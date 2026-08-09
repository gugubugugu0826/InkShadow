use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;

use super::error::CommandError;
use super::types::{GenerationUsage, ModelDescriptor, RerankScore};

pub(crate) const MAX_MODELS: usize = 10_000;
const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_MODEL_DISPLAY_NAME_BYTES: usize = 1_024;
const MAX_CURSOR_BYTES: usize = 8_192;
const MAX_STREAM_LINE_BYTES: usize = 1024 * 1024;
const MAX_OPENAI_JSON_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_USAGE_TOKENS: u64 = 100_000_000;
pub(crate) const MAX_EMBEDDING_DIMENSION: usize = 4_096;
pub(crate) const MAX_EMBEDDING_VALUES: usize = 524_288;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StreamItem {
    Delta(String),
    Reasoning { length: u64 },
    Usage(GenerationUsage),
    FinishReason(String),
    Done,
}

#[derive(Debug)]
pub(crate) struct PaginatedModels {
    pub(crate) models: Vec<ModelDescriptor>,
    pub(crate) next_cursor: Option<String>,
}

#[derive(Default)]
struct LineBuffer {
    bytes: Vec<u8>,
}

impl LineBuffer {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, CommandError> {
        self.bytes.extend_from_slice(chunk);
        let mut lines = Vec::new();

        while let Some(index) = self.bytes.iter().position(|byte| *byte == b'\n') {
            let remainder = self.bytes.split_off(index + 1);
            let mut line = std::mem::replace(&mut self.bytes, remainder);
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.len() > MAX_STREAM_LINE_BYTES {
                return Err(CommandError::response_limit_exceeded());
            }
            lines.push(line);
        }

        if self.bytes.len() > MAX_STREAM_LINE_BYTES {
            return Err(CommandError::response_limit_exceeded());
        }
        Ok(lines)
    }

    fn finish(&mut self) -> Result<Option<Vec<u8>>, CommandError> {
        if self.bytes.is_empty() {
            return Ok(None);
        }
        if self.bytes.len() > MAX_STREAM_LINE_BYTES {
            return Err(CommandError::response_limit_exceeded());
        }
        let mut line = std::mem::take(&mut self.bytes);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        Ok(Some(line))
    }
}

#[derive(Debug)]
struct BufferedSseEvent {
    name: Option<String>,
    data: Vec<u8>,
}

#[derive(Default)]
struct SseEventBuffer {
    lines: LineBuffer,
    event_name: Option<String>,
    data_lines: Vec<Vec<u8>>,
}

impl SseEventBuffer {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<BufferedSseEvent>, CommandError> {
        let mut events = Vec::new();
        for line in self.lines.push(chunk)? {
            self.consume_line(&line, &mut events)?;
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<BufferedSseEvent>, CommandError> {
        let mut events = Vec::new();
        if let Some(line) = self.lines.finish()? {
            self.consume_line(&line, &mut events)?;
        }
        self.flush_event(&mut events)?;
        Ok(events)
    }

    fn consume_line(
        &mut self,
        line: &[u8],
        events: &mut Vec<BufferedSseEvent>,
    ) -> Result<(), CommandError> {
        if line.is_empty() {
            return self.flush_event(events);
        }
        if line.starts_with(b":") {
            return Ok(());
        }
        if let Some(name) = line.strip_prefix(b"event:") {
            let name = name.strip_prefix(b" ").unwrap_or(name);
            let name = std::str::from_utf8(name).map_err(|_| CommandError::response_invalid())?;
            if name.is_empty()
                || name.len() > 128
                || name
                    .chars()
                    .any(|character| character.is_control() || character.is_whitespace())
            {
                return Err(CommandError::response_invalid());
            }
            self.event_name = Some(name.to_owned());
        } else if let Some(data) = line.strip_prefix(b"data:") {
            self.data_lines
                .push(data.strip_prefix(b" ").unwrap_or(data).to_vec());
            let data_bytes = self.data_lines.iter().map(Vec::len).sum::<usize>();
            if data_bytes > MAX_STREAM_LINE_BYTES {
                return Err(CommandError::response_limit_exceeded());
            }
        }
        Ok(())
    }

    fn flush_event(&mut self, events: &mut Vec<BufferedSseEvent>) -> Result<(), CommandError> {
        if self.data_lines.is_empty() {
            self.event_name = None;
            return Ok(());
        }
        let lines = std::mem::take(&mut self.data_lines);
        let capacity = lines.iter().map(Vec::len).sum::<usize>() + lines.len().saturating_sub(1);
        let mut data = Vec::with_capacity(capacity);
        for (index, line) in lines.iter().enumerate() {
            if index > 0 {
                data.push(b'\n');
            }
            data.extend_from_slice(line);
        }
        events.push(BufferedSseEvent {
            name: self.event_name.take(),
            data,
        });
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct OpenAiSseParser {
    lines: LineBuffer,
    data_lines: Vec<Vec<u8>>,
    saw_finish_reason: bool,
    saw_done: bool,
}

pub(crate) struct OpenAiResponseParser {
    mode: OpenAiResponseMode,
}

enum OpenAiResponseMode {
    Detecting(Vec<u8>),
    Sse(OpenAiSseParser),
    Json(OpenAiJsonParser),
}

#[derive(Default)]
struct OpenAiJsonParser {
    bytes: Vec<u8>,
}

#[derive(Clone, Copy)]
enum OpenAiResponseFormat {
    Sse,
    Json,
}

impl Default for OpenAiResponseParser {
    fn default() -> Self {
        Self {
            mode: OpenAiResponseMode::Detecting(Vec::new()),
        }
    }
}

impl OpenAiResponseParser {
    pub(crate) fn streamed(&self) -> Option<bool> {
        match self.mode {
            OpenAiResponseMode::Detecting(_) => None,
            OpenAiResponseMode::Sse(_) => Some(true),
            OpenAiResponseMode::Json(_) => Some(false),
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamItem>, CommandError> {
        if let OpenAiResponseMode::Detecting(bytes) = &mut self.mode {
            if bytes.len().saturating_add(chunk.len()) > MAX_OPENAI_JSON_BODY_BYTES {
                return Err(CommandError::response_limit_exceeded());
            }
            bytes.extend_from_slice(chunk);
            let Some(format) = detect_openai_response_format(bytes)? else {
                return Ok(Vec::new());
            };
            let buffered = std::mem::take(bytes);
            self.mode = match format {
                OpenAiResponseFormat::Sse => OpenAiResponseMode::Sse(OpenAiSseParser::default()),
                OpenAiResponseFormat::Json => OpenAiResponseMode::Json(OpenAiJsonParser::default()),
            };
            return self.push(&buffered);
        }

        match &mut self.mode {
            OpenAiResponseMode::Sse(parser) => parser.push(chunk),
            OpenAiResponseMode::Json(parser) => parser.push(chunk),
            OpenAiResponseMode::Detecting(_) => unreachable!("detecting mode handled above"),
        }
    }

    pub(crate) fn finish(&mut self) -> Result<Vec<StreamItem>, CommandError> {
        let mut items = Vec::new();
        if let OpenAiResponseMode::Detecting(bytes) = &mut self.mode {
            let format =
                detect_openai_response_format(bytes)?.ok_or_else(CommandError::response_invalid)?;
            let buffered = std::mem::take(bytes);
            self.mode = match format {
                OpenAiResponseFormat::Sse => OpenAiResponseMode::Sse(OpenAiSseParser::default()),
                OpenAiResponseFormat::Json => OpenAiResponseMode::Json(OpenAiJsonParser::default()),
            };
            items.extend(self.push(&buffered)?);
        }

        items.extend(match &mut self.mode {
            OpenAiResponseMode::Sse(parser) => parser.finish(),
            OpenAiResponseMode::Json(parser) => parser.finish(),
            OpenAiResponseMode::Detecting(_) => unreachable!("detecting mode handled above"),
        }?);
        Ok(items)
    }
}

impl OpenAiJsonParser {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamItem>, CommandError> {
        if self.bytes.len().saturating_add(chunk.len()) > MAX_OPENAI_JSON_BODY_BYTES {
            return Err(CommandError::response_limit_exceeded());
        }
        self.bytes.extend_from_slice(chunk);
        Ok(Vec::new())
    }

    fn finish(&mut self) -> Result<Vec<StreamItem>, CommandError> {
        let bytes = std::mem::take(&mut self.bytes);
        parse_openai_json_response(&bytes)
    }
}

fn detect_openai_response_format(
    bytes: &[u8],
) -> Result<Option<OpenAiResponseFormat>, CommandError> {
    let Some(start) = bytes.iter().position(|byte| !byte.is_ascii_whitespace()) else {
        return Ok(None);
    };
    let payload = &bytes[start..];
    if payload.first() == Some(&b'{') {
        return Ok(Some(OpenAiResponseFormat::Json));
    }

    for prefix in [b"data:".as_slice(), b"event:".as_slice(), b":".as_slice()] {
        if payload.starts_with(prefix) {
            return Ok(Some(OpenAiResponseFormat::Sse));
        }
        if prefix.starts_with(payload) {
            return Ok(None);
        }
    }
    Err(CommandError::response_invalid())
}

impl OpenAiSseParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamItem>, CommandError> {
        let mut items = Vec::new();
        for line in self.lines.push(chunk)? {
            self.consume_line(&line, &mut items)?;
        }
        Ok(items)
    }

    pub(crate) fn finish(&mut self) -> Result<Vec<StreamItem>, CommandError> {
        let mut items = Vec::new();
        if let Some(line) = self.lines.finish()? {
            self.consume_line(&line, &mut items)?;
        }
        self.flush_event(&mut items)?;
        if self.saw_finish_reason && !self.saw_done {
            self.saw_done = true;
            items.push(StreamItem::Done);
        }
        Ok(items)
    }

    fn consume_line(
        &mut self,
        line: &[u8],
        items: &mut Vec<StreamItem>,
    ) -> Result<(), CommandError> {
        if line.is_empty() {
            return self.flush_event(items);
        }
        if line.starts_with(b":") {
            return Ok(());
        }
        if let Some(data) = line.strip_prefix(b"data:") {
            self.data_lines
                .push(data.strip_prefix(b" ").unwrap_or(data).to_vec());
            let data_bytes = self.data_lines.iter().map(Vec::len).sum::<usize>();
            if data_bytes > MAX_STREAM_LINE_BYTES {
                return Err(CommandError::response_limit_exceeded());
            }
        }
        Ok(())
    }

    fn flush_event(&mut self, items: &mut Vec<StreamItem>) -> Result<(), CommandError> {
        if self.data_lines.is_empty() {
            return Ok(());
        }

        let lines = std::mem::take(&mut self.data_lines);
        let capacity = lines.iter().map(Vec::len).sum::<usize>() + lines.len().saturating_sub(1);
        let mut data = Vec::with_capacity(capacity);
        for (index, line) in lines.iter().enumerate() {
            if index > 0 {
                data.push(b'\n');
            }
            data.extend_from_slice(line);
        }

        if data == b"[DONE]" {
            if !self.saw_done {
                self.saw_done = true;
                items.push(StreamItem::Done);
            }
            return Ok(());
        }
        self.saw_finish_reason |= parse_openai_stream_data(&data, items)?;
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct OllamaNdjsonParser {
    lines: LineBuffer,
}

#[derive(Default)]
pub(crate) struct AnthropicSseParser {
    events: SseEventBuffer,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    cached_input_tokens: Option<u32>,
    saw_final_usage: bool,
    saw_stop: bool,
}

impl AnthropicSseParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamItem>, CommandError> {
        let mut items = Vec::new();
        for event in self.events.push(chunk)? {
            self.consume_event(event, &mut items)?;
        }
        Ok(items)
    }

    pub(crate) fn finish(&mut self) -> Result<Vec<StreamItem>, CommandError> {
        let mut items = Vec::new();
        for event in self.events.finish()? {
            self.consume_event(event, &mut items)?;
        }
        Ok(items)
    }

    fn consume_event(
        &mut self,
        event: BufferedSseEvent,
        items: &mut Vec<StreamItem>,
    ) -> Result<(), CommandError> {
        let envelope: Value =
            serde_json::from_slice(&event.data).map_err(|_| CommandError::response_invalid())?;
        let event_type = envelope
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(CommandError::response_invalid)?;
        if event.name.as_deref() == Some("error") || event_type == "error" {
            return Err(CommandError::provider_error());
        }
        if let Some(name) = event.name.as_deref() {
            if name != event_type {
                return Err(CommandError::response_invalid());
            }
        }

        match event_type {
            "message_start" => {
                if let Some(usage) = envelope
                    .get("message")
                    .and_then(|message| message.get("usage"))
                {
                    self.update_anthropic_usage(usage)?;
                }
            }
            "content_block_delta" => {
                let Some(delta) = envelope.get("delta") else {
                    return Err(CommandError::response_invalid());
                };
                if delta.get("type").and_then(Value::as_str) == Some("text_delta") {
                    let text = delta
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or_else(CommandError::response_invalid)?;
                    if !text.is_empty() {
                        validate_delta(text)?;
                        items.push(StreamItem::Delta(text.to_owned()));
                    }
                }
            }
            "message_delta" => {
                if let Some(usage) = envelope.get("usage") {
                    self.update_anthropic_usage(usage)?;
                    self.saw_final_usage = true;
                }
            }
            "message_stop" => {
                if self.saw_stop {
                    return Err(CommandError::response_invalid());
                }
                self.saw_stop = true;
                if self.saw_final_usage {
                    if let (Some(input_tokens), Some(output_tokens)) =
                        (self.input_tokens, self.output_tokens)
                    {
                        items.push(StreamItem::Usage(GenerationUsage {
                            input_tokens,
                            output_tokens,
                            cached_input_tokens: self.cached_input_tokens,
                        }));
                    }
                }
                items.push(StreamItem::Done);
            }
            // Anthropic's versioning policy allows new event types. Unknown events and
            // non-text content deltas are intentionally ignored by this text-only gateway.
            _ => {}
        }
        Ok(())
    }

    fn update_anthropic_usage(&mut self, usage: &Value) -> Result<(), CommandError> {
        if !usage.is_object() {
            return Err(CommandError::response_invalid());
        }
        if let Some(value) = usage.get("input_tokens") {
            self.input_tokens = Some(value_as_usage_tokens(value)?);
        }
        if let Some(value) = usage.get("output_tokens") {
            self.output_tokens = Some(value_as_usage_tokens(value)?);
        }
        if let Some(value) = usage.get("cache_read_input_tokens") {
            self.cached_input_tokens = Some(value_as_usage_tokens(value)?);
        }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct GeminiSseParser {
    events: SseEventBuffer,
    usage: Option<GenerationUsage>,
    saw_finish_reason: bool,
}

impl GeminiSseParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamItem>, CommandError> {
        let mut items = Vec::new();
        for event in self.events.push(chunk)? {
            self.consume_event(event, &mut items)?;
        }
        Ok(items)
    }

    pub(crate) fn finish(&mut self) -> Result<Vec<StreamItem>, CommandError> {
        let mut items = Vec::new();
        for event in self.events.finish()? {
            self.consume_event(event, &mut items)?;
        }
        if self.saw_finish_reason {
            if let Some(usage) = self.usage.take() {
                items.push(StreamItem::Usage(usage));
            }
            items.push(StreamItem::Done);
        }
        Ok(items)
    }

    fn consume_event(
        &mut self,
        event: BufferedSseEvent,
        items: &mut Vec<StreamItem>,
    ) -> Result<(), CommandError> {
        if event.name.as_deref().is_some_and(|name| name == "error") {
            return Err(CommandError::provider_error());
        }
        let envelope: GeminiStreamEnvelope =
            serde_json::from_slice(&event.data).map_err(|_| CommandError::response_invalid())?;
        if envelope.error.is_some_and(|error| !error.is_null())
            || envelope
                .prompt_feedback
                .as_ref()
                .and_then(|feedback| feedback.block_reason.as_deref())
                .filter(|reason| !reason.is_empty())
                .is_some()
        {
            return Err(CommandError::provider_error());
        }
        if envelope.candidates.len() > 1 {
            return Err(CommandError::response_invalid());
        }
        if let Some(candidate) = envelope.candidates.first() {
            if let Some(content) = candidate.content.as_ref() {
                for part in &content.parts {
                    if part.thought.unwrap_or(false) {
                        continue;
                    }
                    if let Some(text) = part.text.as_deref().filter(|text| !text.is_empty()) {
                        validate_delta(text)?;
                        items.push(StreamItem::Delta(text.to_owned()));
                    }
                }
            }
            if candidate
                .finish_reason
                .as_deref()
                .is_some_and(|reason| !reason.is_empty())
            {
                self.saw_finish_reason = true;
            }
        }
        if let Some(usage) = envelope.usage_metadata {
            self.usage = gemini_usage(usage)?;
        }
        Ok(())
    }
}

impl OllamaNdjsonParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamItem>, CommandError> {
        let mut items = Vec::new();
        for line in self.lines.push(chunk)? {
            parse_ollama_stream_line(&line, &mut items)?;
        }
        Ok(items)
    }

    pub(crate) fn finish(&mut self) -> Result<Vec<StreamItem>, CommandError> {
        let mut items = Vec::new();
        if let Some(line) = self.lines.finish()? {
            parse_ollama_stream_line(&line, &mut items)?;
        }
        Ok(items)
    }
}

#[derive(Deserialize)]
struct OpenAiModelsEnvelope {
    data: Vec<OpenAiModel>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Deserialize)]
struct OllamaModelsEnvelope {
    models: Vec<OllamaModel>,
}

#[derive(Deserialize)]
struct OllamaModel {
    name: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Deserialize)]
struct AnthropicModelsEnvelope {
    data: Vec<AnthropicModel>,
    #[serde(default)]
    has_more: bool,
    last_id: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicModel {
    id: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModelsEnvelope {
    #[serde(default)]
    models: Vec<GeminiModel>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModel {
    name: String,
    display_name: Option<String>,
}

pub(crate) fn parse_openai_models(body: &[u8]) -> Result<Vec<ModelDescriptor>, CommandError> {
    let envelope: OpenAiModelsEnvelope =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    normalize_models(
        envelope
            .data
            .into_iter()
            .map(|model| (model.id.clone(), model.id, None)),
    )
}

pub(crate) fn parse_ollama_models(body: &[u8]) -> Result<Vec<ModelDescriptor>, CommandError> {
    let envelope: OllamaModelsEnvelope =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    normalize_models(envelope.models.into_iter().map(|model| {
        (
            model.name.clone(),
            model.name,
            model.size.filter(|size| *size > 0),
        )
    }))
}

pub(crate) fn parse_anthropic_models_page(body: &[u8]) -> Result<PaginatedModels, CommandError> {
    let envelope: AnthropicModelsEnvelope =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    let next_cursor = if envelope.has_more {
        Some(validate_cursor(
            envelope
                .last_id
                .ok_or_else(CommandError::response_invalid)?,
        )?)
    } else {
        None
    };
    let models = normalize_models(
        envelope
            .data
            .into_iter()
            .map(|model| (model.id, model.display_name, None)),
    )?;
    Ok(PaginatedModels {
        models,
        next_cursor,
    })
}

pub(crate) fn parse_gemini_models_page(body: &[u8]) -> Result<PaginatedModels, CommandError> {
    let envelope: GeminiModelsEnvelope =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    let next_cursor = envelope.next_page_token.map(validate_cursor).transpose()?;
    let models = normalize_models(envelope.models.into_iter().map(|model| {
        let display_name = model.display_name.unwrap_or_else(|| model.name.clone());
        (model.name, display_name, None)
    }))?;
    Ok(PaginatedModels {
        models,
        next_cursor,
    })
}

fn normalize_models(
    entries: impl IntoIterator<Item = (String, String, Option<u64>)>,
) -> Result<Vec<ModelDescriptor>, CommandError> {
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for (id, display_name, size_bytes) in entries {
        validate_model_text(&id)?;
        validate_model_display_name(&display_name)?;
        if seen.insert(id.clone()) {
            models.push(ModelDescriptor {
                display_name,
                id,
                size_bytes,
            });
        }
        if models.len() > MAX_MODELS {
            return Err(CommandError::response_limit_exceeded());
        }
    }
    Ok(models)
}

fn validate_model_display_name(value: &str) -> Result<(), CommandError> {
    if value.is_empty()
        || value.len() > MAX_MODEL_DISPLAY_NAME_BYTES
        || value.trim() != value
        || value.chars().any(|character| character.is_control())
    {
        Err(CommandError::response_invalid())
    } else {
        Ok(())
    }
}

fn validate_cursor(value: String) -> Result<String, CommandError> {
    if value.is_empty()
        || value.len() > MAX_CURSOR_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        Err(CommandError::response_invalid())
    } else {
        Ok(value)
    }
}

fn validate_model_text(value: &str) -> Result<(), CommandError> {
    if value.is_empty()
        || value.len() > MAX_MODEL_ID_BYTES
        || value.trim() != value
        || value.chars().any(|character| character.is_control())
    {
        Err(CommandError::response_invalid())
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
struct OpenAiEmbeddingsEnvelope {
    data: Vec<OpenAiEmbedding>,
    model: String,
    error: Option<Value>,
}

#[derive(Deserialize)]
struct OpenAiEmbedding {
    index: usize,
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct OllamaEmbeddingsEnvelope {
    model: String,
    embeddings: Vec<Vec<f32>>,
    error: Option<Value>,
}

#[derive(Deserialize)]
struct GeminiEmbeddingsEnvelope {
    embeddings: Vec<GeminiEmbedding>,
    error: Option<Value>,
}

#[derive(Deserialize)]
struct GeminiEmbedding {
    values: Vec<f32>,
}

pub(crate) fn parse_openai_embeddings(
    body: &[u8],
    expected_model: &str,
    expected_count: usize,
) -> Result<Vec<Vec<f32>>, CommandError> {
    let envelope: OpenAiEmbeddingsEnvelope =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    validate_embedding_model(&envelope.model, expected_model)?;
    if envelope.error.is_some_and(|error| !error.is_null()) || envelope.data.len() != expected_count
    {
        return Err(CommandError::response_invalid());
    }

    let mut ordered = (0..expected_count)
        .map(|_| None)
        .collect::<Vec<Option<Vec<f32>>>>();
    for item in envelope.data {
        let slot = ordered
            .get_mut(item.index)
            .ok_or_else(CommandError::response_invalid)?;
        if slot.replace(item.embedding).is_some() {
            return Err(CommandError::response_invalid());
        }
    }
    validate_embeddings(
        ordered
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or_else(CommandError::response_invalid)?,
        expected_count,
    )
}

pub(crate) fn parse_ollama_embeddings(
    body: &[u8],
    expected_model: &str,
    expected_count: usize,
) -> Result<Vec<Vec<f32>>, CommandError> {
    let envelope: OllamaEmbeddingsEnvelope =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    validate_embedding_model(&envelope.model, expected_model)?;
    if envelope.error.is_some_and(|error| !error.is_null()) {
        return Err(CommandError::response_invalid());
    }
    validate_embeddings(envelope.embeddings, expected_count)
}

pub(crate) fn parse_gemini_embeddings(
    body: &[u8],
    expected_count: usize,
) -> Result<Vec<Vec<f32>>, CommandError> {
    let envelope: GeminiEmbeddingsEnvelope =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    if envelope.error.is_some_and(|error| !error.is_null()) {
        return Err(CommandError::provider_error());
    }
    validate_embeddings(
        envelope
            .embeddings
            .into_iter()
            .map(|embedding| embedding.values)
            .collect(),
        expected_count,
    )
}

fn validate_embedding_model(value: &str, expected: &str) -> Result<(), CommandError> {
    validate_model_text(value)?;
    if value != expected {
        return Err(CommandError::response_invalid());
    }
    Ok(())
}

fn validate_embeddings(
    embeddings: Vec<Vec<f32>>,
    expected_count: usize,
) -> Result<Vec<Vec<f32>>, CommandError> {
    if expected_count == 0 || embeddings.len() != expected_count {
        return Err(CommandError::response_invalid());
    }
    let dimension = embeddings
        .first()
        .map(Vec::len)
        .filter(|dimension| (1..=MAX_EMBEDDING_DIMENSION).contains(dimension))
        .ok_or_else(CommandError::response_invalid)?;
    let total_values = dimension
        .checked_mul(embeddings.len())
        .filter(|total| *total <= MAX_EMBEDDING_VALUES)
        .ok_or_else(CommandError::response_limit_exceeded)?;
    debug_assert!(total_values > 0);

    if embeddings.iter().any(|embedding| {
        embedding.len() != dimension
            || embedding.iter().any(|value| !value.is_finite())
            || !embedding.iter().any(|value| *value != 0.0)
    }) {
        return Err(CommandError::response_invalid());
    }
    Ok(embeddings)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QwenRerankEnvelope {
    object: String,
    results: Vec<QwenRerankResult>,
    model: String,
    #[serde(rename = "id")]
    _id: String,
    usage: Option<QwenRerankUsage>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QwenRerankResult {
    index: usize,
    relevance_score: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QwenRerankUsage {
    total_tokens: u64,
}

pub(crate) fn parse_qwen_rerank(
    body: &[u8],
    expected_model: &str,
    document_count: usize,
    top_n: usize,
) -> Result<(Vec<RerankScore>, Option<u32>), CommandError> {
    let envelope: QwenRerankEnvelope =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    validate_model_text(&envelope.model)?;
    if envelope.object != "list"
        || envelope.model != expected_model
        || envelope._id.is_empty()
        || envelope._id.len() > 1_024
        || envelope._id.chars().any(char::is_control)
        || document_count == 0
        || top_n == 0
        || top_n > document_count
        || envelope.results.is_empty()
        || envelope.results.len() > top_n
    {
        return Err(CommandError::response_invalid());
    }

    let mut seen = HashSet::with_capacity(envelope.results.len());
    let mut rankings = Vec::with_capacity(envelope.results.len());
    for result in envelope.results {
        if result.index >= document_count
            || !seen.insert(result.index)
            || !result.relevance_score.is_finite()
            || !(0.0..=1.0).contains(&result.relevance_score)
        {
            return Err(CommandError::response_invalid());
        }
        rankings.push(RerankScore {
            index: result.index,
            relevance_score: result.relevance_score,
        });
    }
    rankings.sort_by(|left, right| {
        right
            .relevance_score
            .total_cmp(&left.relevance_score)
            .then_with(|| left.index.cmp(&right.index))
    });

    let input_tokens = match envelope.usage {
        None => None,
        Some(usage) if usage.total_tokens <= MAX_USAGE_TOKENS => {
            Some(u32::try_from(usage.total_tokens).map_err(|_| CommandError::response_invalid())?)
        }
        Some(_) => return Err(CommandError::response_invalid()),
    };
    Ok((rankings, input_tokens))
}

#[derive(Deserialize)]
struct OpenAiStreamEnvelope {
    #[serde(default)]
    choices: Vec<OpenAiChoice>,
    error: Option<Value>,
    usage: Option<OpenAiUsage>,
}

#[derive(Deserialize)]
struct OpenAiJsonEnvelope {
    #[serde(default)]
    choices: Vec<OpenAiJsonChoice>,
    error: Option<Value>,
    usage: Option<OpenAiUsage>,
}

#[derive(Deserialize)]
struct OpenAiJsonChoice {
    message: Option<OpenAiJsonMessage>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiJsonMessage {
    content: Option<Value>,
    reasoning_content: Option<Value>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    delta: Option<OpenAiDelta>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiDelta {
    content: Option<Value>,
    reasoning_content: Option<Value>,
}

#[derive(Deserialize)]
struct OpenAiUsage {
    prompt_tokens: u64,
    completion_tokens: u64,
    prompt_tokens_details: Option<OpenAiPromptTokenDetails>,
}

#[derive(Deserialize)]
struct OpenAiPromptTokenDetails {
    cached_tokens: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiStreamEnvelope {
    #[serde(default)]
    candidates: Vec<GeminiCandidate>,
    prompt_feedback: Option<GeminiPromptFeedback>,
    usage_metadata: Option<GeminiUsageMetadata>,
    error: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiCandidate {
    content: Option<GeminiContent>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct GeminiContent {
    #[serde(default)]
    parts: Vec<GeminiPart>,
}

#[derive(Deserialize)]
struct GeminiPart {
    text: Option<String>,
    thought: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiPromptFeedback {
    block_reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiUsageMetadata {
    prompt_token_count: Option<u64>,
    candidates_token_count: Option<u64>,
    cached_content_token_count: Option<u64>,
}

fn gemini_usage(usage: GeminiUsageMetadata) -> Result<Option<GenerationUsage>, CommandError> {
    let (Some(input_tokens), Some(output_tokens)) =
        (usage.prompt_token_count, usage.candidates_token_count)
    else {
        return Ok(None);
    };
    let input_tokens = validate_usage_tokens(input_tokens)?;
    let cached_input_tokens = usage
        .cached_content_token_count
        .map(validate_usage_tokens)
        .transpose()?;
    if cached_input_tokens.is_some_and(|cached| cached > input_tokens) {
        return Err(CommandError::response_invalid());
    }
    Ok(Some(GenerationUsage {
        input_tokens,
        output_tokens: validate_usage_tokens(output_tokens)?,
        cached_input_tokens,
    }))
}

fn parse_openai_stream_data(
    data: &[u8],
    items: &mut Vec<StreamItem>,
) -> Result<bool, CommandError> {
    let envelope: OpenAiStreamEnvelope =
        serde_json::from_slice(data).map_err(|_| CommandError::response_invalid())?;
    if envelope.error.is_some_and(|error| !error.is_null()) {
        return Err(CommandError::provider_error());
    }
    if envelope.choices.len() > 1 {
        return Err(CommandError::response_invalid());
    }

    let mut saw_finish_reason = false;
    if let Some(choice) = envelope.choices.first() {
        if let Some(delta) = choice.delta.as_ref() {
            if let Some(content) = delta.content.as_ref() {
                let text = openai_content_text(content)?;
                if !text.is_empty() {
                    validate_delta(&text)?;
                    items.push(StreamItem::Delta(text));
                }
            }
            if let Some(length) = openai_reasoning_length(delta.reasoning_content.as_ref())? {
                items.push(StreamItem::Reasoning { length });
            }
        }
        if let Some(usage) = envelope.usage {
            items.push(StreamItem::Usage(openai_usage(usage)?));
        }
        if let Some(finish_reason) =
            normalized_openai_finish_reason(choice.finish_reason.as_deref(), false)?
        {
            saw_finish_reason = true;
            items.push(StreamItem::FinishReason(finish_reason));
        }
    } else if let Some(usage) = envelope.usage {
        items.push(StreamItem::Usage(openai_usage(usage)?));
    }
    Ok(saw_finish_reason)
}

fn parse_openai_json_response(body: &[u8]) -> Result<Vec<StreamItem>, CommandError> {
    let envelope: OpenAiJsonEnvelope =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    if envelope.error.is_some_and(|error| !error.is_null()) {
        return Err(CommandError::provider_error());
    }
    if envelope.choices.len() != 1 {
        return Err(CommandError::response_invalid());
    }

    let choice = envelope
        .choices
        .first()
        .ok_or_else(CommandError::response_invalid)?;
    let finish_reason = normalized_openai_finish_reason(choice.finish_reason.as_deref(), true)?
        .ok_or_else(CommandError::stream_truncated)?;
    let message = choice
        .message
        .as_ref()
        .ok_or_else(CommandError::response_invalid)?;
    let text = match message.content.as_ref() {
        Some(content) => openai_content_text(content)?,
        None => String::new(),
    };

    let mut items = Vec::new();
    if !text.is_empty() {
        validate_delta(&text)?;
        items.push(StreamItem::Delta(text));
    }
    if let Some(length) = openai_reasoning_length(message.reasoning_content.as_ref())? {
        items.push(StreamItem::Reasoning { length });
    }
    if let Some(usage) = envelope.usage {
        items.push(StreamItem::Usage(openai_usage(usage)?));
    }
    items.push(StreamItem::FinishReason(finish_reason));
    items.push(StreamItem::Done);
    Ok(items)
}

fn normalized_openai_finish_reason(
    finish_reason: Option<&str>,
    required: bool,
) -> Result<Option<String>, CommandError> {
    let Some(finish_reason) = finish_reason else {
        return if required {
            Err(CommandError::stream_truncated())
        } else {
            Ok(None)
        };
    };
    if finish_reason.is_empty()
        || finish_reason.len() > 128
        || finish_reason
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(CommandError::response_invalid());
    }
    Ok(Some(finish_reason.to_ascii_lowercase()))
}

fn openai_reasoning_length(reasoning: Option<&Value>) -> Result<Option<u64>, CommandError> {
    let Some(reasoning) = reasoning else {
        return Ok(None);
    };
    if reasoning.is_null() {
        return Ok(None);
    }
    let text = reasoning
        .as_str()
        .ok_or_else(CommandError::response_invalid)?;
    u64::try_from(text.len())
        .map(Some)
        .map_err(|_| CommandError::response_limit_exceeded())
}

fn openai_usage(usage: OpenAiUsage) -> Result<GenerationUsage, CommandError> {
    let input_tokens = validate_usage_tokens(usage.prompt_tokens)?;
    let cached_input_tokens = usage
        .prompt_tokens_details
        .and_then(|details| details.cached_tokens)
        .map(validate_usage_tokens)
        .transpose()?;
    if cached_input_tokens.is_some_and(|cached| cached > input_tokens) {
        return Err(CommandError::response_invalid());
    }
    Ok(GenerationUsage {
        input_tokens,
        output_tokens: validate_usage_tokens(usage.completion_tokens)?,
        cached_input_tokens,
    })
}

fn openai_content_text(content: &Value) -> Result<String, CommandError> {
    if content.is_null() {
        return Ok(String::new());
    }
    if let Some(text) = content.as_str() {
        return Ok(text.to_owned());
    }
    let mut text = String::new();
    if let Some(parts) = content.as_array() {
        for part in parts {
            append_openai_content_part(part, &mut text)?;
        }
        return Ok(text);
    }
    append_openai_content_part(content, &mut text)?;
    Ok(text)
}

fn append_openai_content_part(part: &Value, output: &mut String) -> Result<(), CommandError> {
    if let Some(text) = part.as_str() {
        output.push_str(text);
        return Ok(());
    }
    let Some(object) = part.as_object() else {
        return Err(CommandError::response_invalid());
    };
    let kind = object.get("type").and_then(Value::as_str);
    if kind.is_some_and(is_openai_reasoning_part) {
        return Ok(());
    }
    if kind.is_some_and(is_openai_non_text_part) {
        return Ok(());
    }
    if kind.is_some_and(|kind| !is_openai_text_part(kind)) {
        return Err(CommandError::response_invalid());
    }

    let text = object
        .get("text")
        .and_then(|value| {
            value
                .as_str()
                .or_else(|| value.get("value").and_then(Value::as_str))
        })
        .ok_or_else(CommandError::response_invalid)?;
    output.push_str(text);
    Ok(())
}

fn is_openai_text_part(kind: &str) -> bool {
    matches!(
        kind.to_ascii_lowercase().as_str(),
        "text" | "output_text" | "text_delta"
    )
}

fn is_openai_reasoning_part(kind: &str) -> bool {
    matches!(
        kind.to_ascii_lowercase().as_str(),
        "reasoning" | "reasoning_text" | "analysis" | "thinking" | "redacted_thinking"
    )
}

fn is_openai_non_text_part(kind: &str) -> bool {
    matches!(
        kind.to_ascii_lowercase().as_str(),
        "image" | "image_url" | "input_image" | "tool_call" | "function_call" | "refusal"
    )
}

#[derive(Deserialize)]
struct OllamaStreamEnvelope {
    message: Option<OllamaStreamMessage>,
    response: Option<String>,
    #[serde(default)]
    done: bool,
    error: Option<String>,
    prompt_eval_count: Option<u64>,
    eval_count: Option<u64>,
}

#[derive(Deserialize)]
struct OllamaStreamMessage {
    content: String,
}

fn parse_ollama_stream_line(line: &[u8], items: &mut Vec<StreamItem>) -> Result<(), CommandError> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(());
    }
    let envelope: OllamaStreamEnvelope =
        serde_json::from_slice(line).map_err(|_| CommandError::response_invalid())?;
    if envelope.error.is_some() {
        return Err(CommandError::provider_error());
    }

    let delta = envelope
        .message
        .map(|message| message.content)
        .or(envelope.response);
    if let Some(delta) = delta.filter(|value| !value.is_empty()) {
        validate_delta(&delta)?;
        items.push(StreamItem::Delta(delta));
    }
    if envelope.done {
        match (envelope.prompt_eval_count, envelope.eval_count) {
            (Some(input_tokens), Some(output_tokens)) => {
                items.push(StreamItem::Usage(GenerationUsage {
                    input_tokens: validate_usage_tokens(input_tokens)?,
                    output_tokens: validate_usage_tokens(output_tokens)?,
                    cached_input_tokens: None,
                }));
            }
            (None, None) => {}
            _ => return Err(CommandError::response_invalid()),
        }
        items.push(StreamItem::Done);
    }
    Ok(())
}

fn validate_usage_tokens(value: u64) -> Result<u32, CommandError> {
    if value > MAX_USAGE_TOKENS {
        return Err(CommandError::response_invalid());
    }
    u32::try_from(value).map_err(|_| CommandError::response_invalid())
}

fn value_as_usage_tokens(value: &Value) -> Result<u32, CommandError> {
    value
        .as_u64()
        .ok_or_else(CommandError::response_invalid)
        .and_then(validate_usage_tokens)
}

fn validate_delta(delta: &str) -> Result<(), CommandError> {
    if delta.len() > MAX_STREAM_LINE_BYTES
        || delta
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        Err(CommandError::response_invalid())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_deduplicates_model_catalogs() {
        let openai = parse_openai_models(
            br#"{"object":"list","data":[{"id":"model-b"},{"id":"model-a"},{"id":"model-a"}]}"#,
        )
        .expect("OpenAI model list should parse");
        assert_eq!(
            openai,
            vec![
                ModelDescriptor {
                    id: "model-b".to_owned(),
                    display_name: "model-b".to_owned(),
                    size_bytes: None,
                },
                ModelDescriptor {
                    id: "model-a".to_owned(),
                    display_name: "model-a".to_owned(),
                    size_bytes: None,
                },
            ]
        );

        let ollama = parse_ollama_models(
            br#"{"models":[{"name":"qwen3:8b","size":123},{"name":"llama3.2:latest"}]}"#,
        )
        .expect("Ollama model list should parse");
        assert_eq!(ollama[0].id, "qwen3:8b");
        assert_eq!(ollama[0].size_bytes, Some(123));
        assert_eq!(ollama[1].id, "llama3.2:latest");
        assert_eq!(ollama[1].size_bytes, None);

        let anthropic = parse_anthropic_models_page(
            br#"{
                "data":[{
                    "id":"claude-example",
                    "display_name":"Claude Example",
                    "type":"model",
                    "created_at":"2026-01-01T00:00:00Z"
                }],
                "has_more":true,
                "last_id":"claude-example"
            }"#,
        )
        .expect("Anthropic model page should parse");
        assert_eq!(anthropic.models[0].id, "claude-example");
        assert_eq!(anthropic.models[0].display_name, "Claude Example");
        assert_eq!(anthropic.next_cursor.as_deref(), Some("claude-example"));

        let gemini = parse_gemini_models_page(
            br#"{
                "models":[{
                    "name":"models/gemini-example",
                    "displayName":"Gemini Example",
                    "supportedActions":["generateContent"]
                }],
                "nextPageToken":"next-page"
            }"#,
        )
        .expect("Gemini model page should parse");
        assert_eq!(gemini.models[0].id, "models/gemini-example");
        assert_eq!(gemini.models[0].display_name, "Gemini Example");
        assert_eq!(gemini.next_cursor.as_deref(), Some("next-page"));
    }

    #[test]
    fn rejects_missing_or_unsafe_model_pagination_cursors() {
        assert!(parse_anthropic_models_page(br#"{"data":[],"has_more":true}"#).is_err());
        assert!(
            parse_gemini_models_page(br#"{"models":[],"nextPageToken":"bad\nvalue"}"#).is_err()
        );
    }

    #[test]
    fn parses_openai_sse_across_arbitrary_chunks() {
        let mut parser = OpenAiSseParser::default();
        let first = parser
            .push(b"data: {\"choices\":[{\"delta\":{\"content\":\"hel")
            .expect("partial data should buffer");
        assert!(first.is_empty());

        let second = parser
            .push(
                b"lo\"},\"finish_reason\":null}]}\r\n\r\ndata: \
                  {\"choices\":[{\"delta\":{\"content\":\"!\"},\"finish_reason\":\"stop\"}]}\n\n\
                  data: {\"choices\":[],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":9,\
                  \"prompt_tokens_details\":{\"cached_tokens\":20}}}\n\n\
                  data: [DONE]\n\n",
            )
            .expect("complete events should parse");
        assert_eq!(
            second,
            vec![
                StreamItem::Delta("hello".to_owned()),
                StreamItem::Delta("!".to_owned()),
                StreamItem::FinishReason("stop".to_owned()),
                StreamItem::Usage(GenerationUsage {
                    input_tokens: 120,
                    output_tokens: 9,
                    cached_input_tokens: Some(20),
                }),
                StreamItem::Done,
            ]
        );
    }

    #[test]
    fn auto_detects_openai_json_and_reads_non_streaming_message_content() {
        let mut parser = OpenAiResponseParser::default();
        assert!(parser
            .push(
                br#"{
                    "choices":[{
                        "message":{
                            "role":"assistant",
                            "reasoning_content":"private chain of thought",
                            "content":"Visible answer"
                        },
                        "finish_reason":"stop"
                    }],
                    "usage":{
                        "prompt_tokens":18,
                        "completion_tokens":4,
                        "prompt_tokens_details":{"cached_tokens":3}
                    }
                }"#,
            )
            .expect("JSON response should buffer")
            .is_empty());

        assert_eq!(
            parser.finish().expect("JSON response should parse"),
            vec![
                StreamItem::Delta("Visible answer".to_owned()),
                StreamItem::Reasoning { length: 24 },
                StreamItem::Usage(GenerationUsage {
                    input_tokens: 18,
                    output_tokens: 4,
                    cached_input_tokens: Some(3),
                }),
                StreamItem::FinishReason("stop".to_owned()),
                StreamItem::Done,
            ]
        );
        assert_eq!(parser.streamed(), Some(false));
    }

    #[test]
    fn accepts_openai_content_parts_without_mixing_reasoning_into_prose() {
        let mut parser = OpenAiResponseParser::default();
        parser
            .push(
                br#"{
                    "choices":[{
                        "message":{
                            "reasoning_content":"hidden sibling reasoning",
                            "content":[
                                {"type":"reasoning","text":"hidden reasoning part"},
                                {"type":"text","text":"Visible"},
                                {"type":"output_text","text":{"value":" answer"}},
                                {"type":"image_url","image_url":{"url":"https://example.invalid/image"}}
                            ]
                        },
                        "finish_reason":"stop"
                    }]
                }"#,
            )
            .expect("content-parts response should buffer");

        assert_eq!(
            parser.finish().expect("content parts should parse"),
            vec![
                StreamItem::Delta("Visible answer".to_owned()),
                StreamItem::Reasoning { length: 24 },
                StreamItem::FinishReason("stop".to_owned()),
                StreamItem::Done,
            ]
        );
    }

    #[test]
    fn keeps_streamed_reasoning_content_separate_from_visible_content_parts() {
        let mut parser = OpenAiResponseParser::default();
        let items = parser
            .push(
                b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hidden\"},\"finish_reason\":null}]}\n\n\
                  data: {\"choices\":[{\"delta\":{\"content\":[{\"type\":\"reasoning\",\"text\":\"also hidden\"},{\"type\":\"text\",\"text\":\"Visible\"}]},\"finish_reason\":\"stop\"}]}\n\n\
                  data: [DONE]\n\n",
            )
            .expect("OpenAI-compatible SSE should parse");

        assert_eq!(
            items,
            vec![
                StreamItem::Reasoning { length: 6 },
                StreamItem::Delta("Visible".to_owned()),
                StreamItem::FinishReason("stop".to_owned()),
                StreamItem::Done,
            ]
        );
        assert_eq!(parser.streamed(), Some(true));
        assert!(parser.finish().expect("stream should finish").is_empty());
    }

    #[test]
    fn preserves_same_frame_content_before_reporting_token_limit_finish_reason() {
        let mut stream = OpenAiResponseParser::default();
        let stream_items = stream
            .push(
                b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hidden\",\"content\":\"partial\"},\"finish_reason\":\"length\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":8}}\n\n",
            )
            .expect("protocol parser must preserve safe same-frame observations");
        assert_eq!(
            stream_items,
            vec![
                StreamItem::Delta("partial".to_owned()),
                StreamItem::Reasoning { length: 6 },
                StreamItem::Usage(GenerationUsage {
                    input_tokens: 2,
                    output_tokens: 8,
                    cached_input_tokens: None,
                }),
                StreamItem::FinishReason("length".to_owned()),
            ]
        );

        let mut json = OpenAiResponseParser::default();
        json.push(
            br#"{"choices":[{"message":{"content":"partial"},"finish_reason":"max_tokens"}]}"#,
        )
        .expect("JSON response should buffer");
        assert_eq!(
            json.finish().expect("JSON observations should parse"),
            vec![
                StreamItem::Delta("partial".to_owned()),
                StreamItem::FinishReason("max_tokens".to_owned()),
                StreamItem::Done,
            ]
        );
    }

    #[test]
    fn parses_ollama_ndjson_and_completion_marker() {
        let mut parser = OllamaNdjsonParser::default();
        let items = parser
            .push(
                b"{\"message\":{\"content\":\"one\"},\"done\":false}\n\
                  {\"message\":{\"content\":\" two\"},\"done\":false}\n\
                  {\"done\":true,\"prompt_eval_count\":42,\"eval_count\":7}\n",
            )
            .expect("NDJSON should parse");

        assert_eq!(
            items,
            vec![
                StreamItem::Delta("one".to_owned()),
                StreamItem::Delta(" two".to_owned()),
                StreamItem::Usage(GenerationUsage {
                    input_tokens: 42,
                    output_tokens: 7,
                    cached_input_tokens: None,
                }),
                StreamItem::Done,
            ]
        );
    }

    #[test]
    fn parses_anthropic_named_sse_text_usage_and_completion() {
        let mut parser = AnthropicSseParser::default();
        let first = parser
            .push(
                b"event: message_start\n\
                  data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":25,\"output_tokens\":1,\"cache_read_input_tokens\":3}}}\n\n\
                  event: ping\n\
                  data: {\"type\":\"ping\"}\n\n\
                  event: content_block_delta\n\
                  data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
            )
            .expect("Anthropic events should parse");
        assert_eq!(first, vec![StreamItem::Delta("Hello".to_owned())]);

        let second = parser
            .push(
                b"event: future_event\n\
                  data: {\"type\":\"future_event\",\"optional\":true}\n\n\
                  event: message_delta\n\
                  data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":15}}\n\n\
                  event: message_stop\n\
                  data: {\"type\":\"message_stop\"}\n\n",
            )
            .expect("Anthropic completion should parse");
        assert_eq!(
            second,
            vec![
                StreamItem::Usage(GenerationUsage {
                    input_tokens: 25,
                    output_tokens: 15,
                    cached_input_tokens: Some(3),
                }),
                StreamItem::Done,
            ]
        );
    }

    #[test]
    fn parses_gemini_sse_without_exposing_thought_parts() {
        let mut parser = GeminiSseParser::default();
        let items = parser
            .push(
                b"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hidden reasoning\",\"thought\":true},{\"text\":\"Visible\"}]}}]}\n\n\
                  data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" answer\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":40,\"candidatesTokenCount\":7,\"cachedContentTokenCount\":5}}\n\n",
            )
            .expect("Gemini stream should parse");
        assert_eq!(
            items,
            vec![
                StreamItem::Delta("Visible".to_owned()),
                StreamItem::Delta(" answer".to_owned()),
            ]
        );
        assert_eq!(
            parser.finish().expect("Gemini stream should complete"),
            vec![
                StreamItem::Usage(GenerationUsage {
                    input_tokens: 40,
                    output_tokens: 7,
                    cached_input_tokens: Some(5),
                }),
                StreamItem::Done,
            ]
        );
    }

    #[test]
    fn completes_openai_streams_without_usage_without_inventing_a_receipt() {
        let mut parser = OpenAiSseParser::default();
        let items = parser
            .push(
                b"data: {\"choices\":[{\"delta\":{\"content\":\"text\"},\
                  \"finish_reason\":\"stop\"}]}\n\n",
            )
            .expect("finish reason should parse");
        assert_eq!(
            items,
            vec![
                StreamItem::Delta("text".to_owned()),
                StreamItem::FinishReason("stop".to_owned()),
            ]
        );
        assert_eq!(
            parser.finish().expect("stream end should complete"),
            vec![StreamItem::Done]
        );
    }

    #[test]
    fn rejects_provider_errors_and_malformed_stream_items() {
        let mut openai = OpenAiSseParser::default();
        assert!(openai
            .push(b"data: {\"error\":{\"message\":\"secret body\"}}\n\n")
            .is_err());

        let mut ollama = OllamaNdjsonParser::default();
        assert!(ollama.push(b"{not-json}\n").is_err());

        let mut anthropic = AnthropicSseParser::default();
        let error = anthropic
            .push(
                b"event: error\n\
                  data: {\"type\":\"error\",\"error\":{\"message\":\"secret body\"}}\n\n",
            )
            .expect_err("Anthropic stream error should be sanitized");
        assert_eq!(error.code(), "MODEL_PROVIDER_ERROR");
        assert!(!serde_json::to_string(&error)
            .expect("error should serialize")
            .contains("secret body"));

        let mut gemini = GeminiSseParser::default();
        assert!(gemini
            .push(b"data: {\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}\n\n")
            .is_err());
    }

    #[test]
    fn parses_embeddings_in_provider_order_without_trusting_openai_array_order() {
        let openai = parse_openai_embeddings(
            br#"{
                "data": [
                    {"index": 1, "embedding": [0.3, 0.4]},
                    {"index": 0, "embedding": [0.1, 0.2]}
                ],
                "model": "embed-1"
            }"#,
            "embed-1",
            2,
        )
        .expect("valid OpenAI embeddings should parse");
        assert_eq!(openai, vec![vec![0.1, 0.2], vec![0.3, 0.4]]);

        let ollama = parse_ollama_embeddings(
            br#"{"model":"nomic-embed-text","embeddings":[[0.1,0.2],[0.3,0.4]]}"#,
            "nomic-embed-text",
            2,
        )
        .expect("valid Ollama embeddings should parse");
        assert_eq!(ollama.len(), 2);

        let gemini = parse_gemini_embeddings(
            br#"{"embeddings":[{"values":[0.1,0.2]},{"values":[0.3,0.4]}]}"#,
            2,
        )
        .expect("valid Gemini embeddings should parse");
        assert_eq!(gemini, vec![vec![0.1, 0.2], vec![0.3, 0.4]]);
    }

    #[test]
    fn rejects_embedding_count_dimension_model_and_numeric_corruption() {
        for body in [
            br#"{"data":[{"index":0,"embedding":[0.1]}],"model":"wrong"}"#.as_slice(),
            br#"{"data":[{"index":0,"embedding":[0.1]},{"index":0,"embedding":[0.2]}],"model":"embed-1"}"#.as_slice(),
            br#"{"data":[{"index":0,"embedding":[0.1]},{"index":1,"embedding":[0.2,0.3]}],"model":"embed-1"}"#.as_slice(),
            br#"{"data":[{"index":0,"embedding":[]}],"model":"embed-1"}"#.as_slice(),
            br#"{"data":[{"index":0,"embedding":[NaN]}],"model":"embed-1"}"#.as_slice(),
            br#"{"data":[{"index":0,"embedding":[1e999]}],"model":"embed-1"}"#.as_slice(),
        ] {
            assert!(
                parse_openai_embeddings(body, "embed-1", 2).is_err(),
                "malformed embedding response must be rejected"
            );
        }

        assert!(parse_ollama_embeddings(
            br#"{"model":"embed-1","embeddings":[[0.1],[0.2,0.3]]}"#,
            "embed-1",
            2,
        )
        .is_err());
        assert!(parse_gemini_embeddings(
            br#"{"embeddings":[{"values":[0.1]},{"values":[0.2,0.3]}]}"#,
            2,
        )
        .is_err());
        assert!(parse_ollama_embeddings(
            br#"{"model":"embed-1","embeddings":[[0.0,0.0]]}"#,
            "embed-1",
            1,
        )
        .is_err());
    }

    #[test]
    fn parses_qwen_rerank_without_returning_documents_and_orders_scores() {
        let (rankings, input_tokens) = parse_qwen_rerank(
            br#"{
                "object":"list",
                "results":[
                    {"index":2,"relevance_score":0.31},
                    {"index":0,"relevance_score":0.93}
                ],
                "model":"qwen3-rerank",
                "id":"request-safe-id",
                "usage":{"total_tokens":79}
            }"#,
            "qwen3-rerank",
            3,
            2,
        )
        .expect("valid Qwen rerank response should parse");

        assert_eq!(rankings[0].index, 0);
        assert_eq!(rankings[1].index, 2);
        assert_eq!(input_tokens, Some(79));
        let serialized = serde_json::to_string(&rankings).expect("rankings should serialize");
        assert!(!serialized.contains("document"));
        assert!(!serialized.contains("query"));
    }

    #[test]
    fn rejects_qwen_rerank_duplicates_out_of_range_scores_and_echoed_documents() {
        for body in [
            br#"{"object":"list","results":[{"index":0,"relevance_score":0.8},{"index":0,"relevance_score":0.7}],"model":"qwen3-rerank","id":"one"}"#.as_slice(),
            br#"{"object":"list","results":[{"index":3,"relevance_score":0.8}],"model":"qwen3-rerank","id":"two"}"#.as_slice(),
            br#"{"object":"list","results":[{"index":0,"relevance_score":1.1}],"model":"qwen3-rerank","id":"three"}"#.as_slice(),
            br#"{"object":"list","results":[{"index":0,"relevance_score":0.8,"document":{"text":"must not be echoed"}}],"model":"qwen3-rerank","id":"four"}"#.as_slice(),
            br#"{"object":"list","results":[],"model":"qwen3-rerank","id":"five"}"#.as_slice(),
            br#"{"object":"list","results":[{"index":0,"relevance_score":0.8}],"model":"other","id":"six"}"#.as_slice(),
        ] {
            assert!(parse_qwen_rerank(body, "qwen3-rerank", 3, 2).is_err());
        }
    }
}
