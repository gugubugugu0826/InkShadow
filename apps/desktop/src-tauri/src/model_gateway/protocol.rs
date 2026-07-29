use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;

use super::error::CommandError;
use super::types::{GenerationUsage, ModelDescriptor};

const MAX_MODELS: usize = 10_000;
const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_STREAM_LINE_BYTES: usize = 1024 * 1024;
const MAX_USAGE_TOKENS: u64 = 100_000_000;
pub(crate) const MAX_EMBEDDING_DIMENSION: usize = 4_096;
pub(crate) const MAX_EMBEDDING_VALUES: usize = 524_288;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StreamItem {
    Delta(String),
    Usage(GenerationUsage),
    Done,
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

#[derive(Default)]
pub(crate) struct OpenAiSseParser {
    lines: LineBuffer,
    data_lines: Vec<Vec<u8>>,
    saw_finish_reason: bool,
    saw_done: bool,
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

pub(crate) fn parse_openai_models(body: &[u8]) -> Result<Vec<ModelDescriptor>, CommandError> {
    let envelope: OpenAiModelsEnvelope =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    normalize_models(envelope.data.into_iter().map(|model| (model.id, None)))
}

pub(crate) fn parse_ollama_models(body: &[u8]) -> Result<Vec<ModelDescriptor>, CommandError> {
    let envelope: OllamaModelsEnvelope =
        serde_json::from_slice(body).map_err(|_| CommandError::response_invalid())?;
    normalize_models(
        envelope
            .models
            .into_iter()
            .map(|model| (model.name, model.size.filter(|size| *size > 0))),
    )
}

fn normalize_models(
    entries: impl IntoIterator<Item = (String, Option<u64>)>,
) -> Result<Vec<ModelDescriptor>, CommandError> {
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for (id, size_bytes) in entries {
        validate_model_text(&id)?;
        if seen.insert(id.clone()) {
            models.push(ModelDescriptor {
                display_name: id.clone(),
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
struct OpenAiStreamEnvelope {
    #[serde(default)]
    choices: Vec<OpenAiChoice>,
    error: Option<Value>,
    usage: Option<OpenAiUsage>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    delta: Option<OpenAiDelta>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiDelta {
    content: Option<Value>,
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
        if let Some(content) = choice
            .delta
            .as_ref()
            .and_then(|delta| delta.content.as_ref())
        {
            let text = openai_content_text(content)?;
            if !text.is_empty() {
                validate_delta(&text)?;
                items.push(StreamItem::Delta(text));
            }
        }
        if choice.finish_reason.is_some() {
            saw_finish_reason = true;
        }
    }
    if let Some(usage) = envelope.usage {
        let input_tokens = validate_usage_tokens(usage.prompt_tokens)?;
        let cached_input_tokens = usage
            .prompt_tokens_details
            .and_then(|details| details.cached_tokens)
            .map(validate_usage_tokens)
            .transpose()?;
        if cached_input_tokens.is_some_and(|cached| cached > input_tokens) {
            return Err(CommandError::response_invalid());
        }
        items.push(StreamItem::Usage(GenerationUsage {
            input_tokens,
            output_tokens: validate_usage_tokens(usage.completion_tokens)?,
            cached_input_tokens,
        }));
    }
    Ok(saw_finish_reason)
}

fn openai_content_text(content: &Value) -> Result<String, CommandError> {
    if content.is_null() {
        return Ok(String::new());
    }
    if let Some(text) = content.as_str() {
        return Ok(text.to_owned());
    }
    let Some(parts) = content.as_array() else {
        return Err(CommandError::response_invalid());
    };

    let mut text = String::new();
    for part in parts {
        let Some(part_text) = part.get("text").and_then(Value::as_str) else {
            return Err(CommandError::response_invalid());
        };
        text.push_str(part_text);
    }
    Ok(text)
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
    fn completes_openai_streams_without_usage_without_inventing_a_receipt() {
        let mut parser = OpenAiSseParser::default();
        let items = parser
            .push(
                b"data: {\"choices\":[{\"delta\":{\"content\":\"text\"},\
                  \"finish_reason\":\"stop\"}]}\n\n",
            )
            .expect("finish reason should parse");
        assert_eq!(items, vec![StreamItem::Delta("text".to_owned())]);
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
        assert!(parse_ollama_embeddings(
            br#"{"model":"embed-1","embeddings":[[0.0,0.0]]}"#,
            "embed-1",
            1,
        )
        .is_err());
    }
}
