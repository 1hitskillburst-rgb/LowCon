use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::ModelProfile;
use super::backend::InferenceBackend;
use super::error::InferenceError;
use super::types::{GenerationConfig, GenerationEvent, ModelMetadata, StopReason};

pub const DEFAULT_LM_STUDIO_ENDPOINT: &str = "http://127.0.0.1:1234/v1";

/// Checks if an HTTP/HTTPS endpoint points strictly to a local loopback interface.
/// Enforces LowCon's offline / local-only security invariant.
pub fn is_local_endpoint(endpoint: &str) -> bool {
    let stripped = endpoint
        .trim_start_matches("http://")
        .trim_start_matches("https://");

    let host_port = stripped.split('/').next().unwrap_or("");
    let host = if let Some(closing) = host_port.find(']') {
        if host_port.starts_with('[') {
            &host_port[1..closing]
        } else {
            host_port.split(':').next().unwrap_or("")
        }
    } else {
        host_port.split(':').next().unwrap_or("")
    };

    matches!(host, "127.0.0.1" | "localhost" | "::1" | "0.0.0.0")
}

/// Backend for local OpenAI-compatible inference servers (LM Studio, Ollama, LocalAI).
pub struct LmStudioBackend {
    endpoint: String,
    active_model: Option<String>,
    metadata: Option<ModelMetadata>,
    timeout: Duration,
}

impl Default for LmStudioBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl LmStudioBackend {
    /// Create a new LM Studio backend with the default endpoint (http://127.0.0.1:1234/v1).
    pub fn new() -> Self {
        Self {
            endpoint: DEFAULT_LM_STUDIO_ENDPOINT.to_string(),
            active_model: None,
            metadata: None,
            timeout: Duration::from_secs(30),
        }
    }

    /// Create with a custom local endpoint (e.g. http://localhost:11434/v1 for Ollama).
    pub fn with_endpoint(endpoint: impl Into<String>) -> Result<Self, InferenceError> {
        let ep = endpoint.into();
        let trimmed = ep.trim_end_matches('/').to_string();
        if !is_local_endpoint(&trimmed) {
            return Err(InferenceError::BackendError(format!(
                "LowCon privacy boundary: Remote endpoint '{}' rejected. Only local loopback addresses (127.0.0.1 / localhost) are permitted.",
                trimmed
            )));
        }
        Ok(Self {
            endpoint: trimmed,
            active_model: None,
            metadata: None,
            timeout: Duration::from_secs(30),
        })
    }

    /// Set active model name directly.
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.active_model = Some(model.into());
        self
    }

    /// Set network timeout.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Current endpoint URL.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Fetch all models currently loaded or available on the local server.
    pub fn fetch_models(endpoint: &str) -> Result<Vec<String>, InferenceError> {
        let clean_ep = endpoint.trim_end_matches('/');
        if !is_local_endpoint(clean_ep) {
            return Err(InferenceError::BackendError(format!(
                "LowCon privacy boundary: Remote endpoint '{}' rejected.",
                clean_ep
            )));
        }

        let url = format!("{}/models", clean_ep);
        let resp = ureq::get(&url)
            .timeout(Duration::from_secs(5))
            .call()
            .map_err(|e| {
                InferenceError::BackendError(format!(
                    "Failed to connect to local inference server at {}: {}. Is LM Studio / Ollama running?",
                    url, e
                ))
            })?;

        #[derive(Deserialize)]
        struct ModelEntry {
            id: String,
        }

        #[derive(Deserialize)]
        struct ModelsResponse {
            data: Vec<ModelEntry>,
        }

        let body: ModelsResponse = resp.into_json().map_err(|e| {
            InferenceError::BackendError(format!("Failed to parse models response from {}: {}", url, e))
        })?;

        Ok(body.data.into_iter().map(|m| m.id).collect())
    }
}

/// Parse a single Server-Sent Events (SSE) line from OpenAI-compatible chat completions stream.
/// Returns (token_chunk, stop_reason).
pub fn parse_sse_line(line: &str) -> Result<Option<(Option<String>, Option<StopReason>)>, InferenceError> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        // Empty line or keep-alive comment
        return Ok(None);
    }

    if let Some(data) = trimmed.strip_prefix("data:") {
        let data = data.trim();
        if data == "[DONE]" {
            return Ok(Some((None, Some(StopReason::Done))));
        }

        let val: Value = serde_json::from_str(data).map_err(|e| {
            InferenceError::BackendError(format!("Invalid SSE JSON chunk: {} (payload: {})", e, data))
        })?;

        let choice = val.get("choices").and_then(|c| c.get(0));
        let delta_content = choice
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());

        let finish_reason = choice
            .and_then(|c| c.get("finish_reason"))
            .and_then(|r| r.as_str());

        let stop = match finish_reason {
            Some("stop") => Some(StopReason::Done),
            Some("length") => Some(StopReason::MaxTokens),
            Some(other) => Some(StopReason::StopSequence(other.to_string())),
            None => None,
        };

        return Ok(Some((delta_content, stop)));
    }

    Ok(None)
}

impl InferenceBackend for LmStudioBackend {
    fn load_model(&mut self, profile: &ModelProfile) -> Result<ModelMetadata, InferenceError> {
        if self.metadata.is_some() {
            return Err(InferenceError::ModelAlreadyLoaded(
                self.active_model.clone().unwrap_or_else(|| "LM Studio model".into()),
            ));
        }

        // Validate local endpoint invariant
        if !is_local_endpoint(&self.endpoint) {
            return Err(InferenceError::BackendError(format!(
                "LowCon privacy boundary: Remote endpoint '{}' rejected.",
                self.endpoint
            )));
        }

        // Determine model identifier
        let model_id = if !profile.name.is_empty() {
            profile.name.clone()
        } else {
            // Attempt to query models list from server
            let models = Self::fetch_models(&self.endpoint)?;
            models.into_iter().next().ok_or_else(|| {
                InferenceError::BackendError("No models found running on local LM Studio server".into())
            })?
        };

        let metadata = ModelMetadata {
            name: model_id.clone(),
            architecture: profile.architecture.clone().unwrap_or_else(|| "local-server".into()),
            quantization: profile.quantization.clone().unwrap_or_else(|| "Server managed".into()),
            context_length: profile.effective_context_limit(),
            file_size_bytes: 0,
            tensor_count: 0,
            embedding_length: None,
            block_count: None,
            chat_template: profile.custom_template.clone(),
            description: Some(format!("Local server model connected to {}", self.endpoint)),
            extra_kv: HashMap::new(),
        };

        self.active_model = Some(model_id);
        self.metadata = Some(metadata.clone());
        Ok(metadata)
    }

    fn unload_model(&mut self) -> Result<(), InferenceError> {
        if self.metadata.is_none() {
            return Err(InferenceError::ModelNotLoaded);
        }
        self.active_model = None;
        self.metadata = None;
        Ok(())
    }

    fn token_count(&self, text: &str) -> Result<usize, InferenceError> {
        if text.is_empty() {
            return Ok(0);
        }
        // Conservative token estimate: words * 4/3 + punctuation
        let words = text.split_whitespace().count();
        let punctuation = text.chars().filter(|c| c.is_ascii_punctuation()).count();
        let count = ((words * 4) + 2) / 3 + ((punctuation + 2) / 3);
        Ok(count.max(1))
    }

    fn stream_generate(
        &mut self,
        prompt: &str,
        config: &GenerationConfig,
        token_tx: Sender<GenerationEvent>,
        cancel_token: Arc<AtomicBool>,
    ) -> Result<(), InferenceError> {
        let model_id = self.active_model.as_ref().ok_or(InferenceError::ModelNotLoaded)?;

        if cancel_token.load(Ordering::Relaxed) {
            let _ = token_tx.send(GenerationEvent::Cancelled);
            return Err(InferenceError::Cancelled);
        }

        let url = format!("{}/chat/completions", self.endpoint);

        #[derive(Serialize)]
        struct ChatMessagePayload<'a> {
            role: &'a str,
            content: &'a str,
        }

        #[derive(Serialize)]
        struct ChatCompletionRequest<'a> {
            model: &'a str,
            messages: Vec<ChatMessagePayload<'a>>,
            temperature: f32,
            top_p: f32,
            max_tokens: usize,
            stream: bool,
            #[serde(skip_serializing_if = "Vec::is_empty")]
            stop: Vec<String>,
        }

        let request_payload = ChatCompletionRequest {
            model: model_id,
            messages: vec![ChatMessagePayload {
                role: "user",
                content: prompt,
            }],
            temperature: config.temperature,
            top_p: config.top_p,
            max_tokens: config.max_tokens,
            stream: true,
            stop: config.stop_sequences.clone(),
        };

        let response = ureq::post(&url)
            .timeout(self.timeout)
            .send_json(&request_payload)
            .map_err(|e| {
                InferenceError::BackendError(format!(
                    "HTTP request to {} failed: {}. Is LM Studio server running with model loaded?",
                    url, e
                ))
            })?;

        let reader = BufReader::new(response.into_reader());
        let mut total_tokens = 0;
        let mut stop_reason = StopReason::Done;

        for line_res in reader.lines() {
            if cancel_token.load(Ordering::Relaxed) {
                let _ = token_tx.send(GenerationEvent::Cancelled);
                return Err(InferenceError::Cancelled);
            }

            let line = line_res.map_err(|e| {
                InferenceError::BackendError(format!("Error reading stream chunk from {}: {}", url, e))
            })?;

            if let Some((content_opt, stop_opt)) = parse_sse_line(&line)? {
                if let Some(content) = content_opt {
                    if !content.is_empty() {
                        total_tokens += 1;
                        if token_tx.send(GenerationEvent::Token(content)).is_err() {
                            return Err(InferenceError::WorkerChannelClosed);
                        }
                    }
                }

                if let Some(stop) = stop_opt {
                    stop_reason = stop;
                    break;
                }
            }
        }

        let _ = token_tx.send(GenerationEvent::Complete {
            total_tokens,
            stop_reason,
        });

        Ok(())
    }

    fn get_metadata(&self) -> Option<&ModelMetadata> {
        self.metadata.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_local_endpoint_privacy_validation() {
        assert!(is_local_endpoint("http://127.0.0.1:1234/v1"));
        assert!(is_local_endpoint("http://localhost:11434/v1"));
        assert!(is_local_endpoint("http://[::1]:8080/v1"));
        assert!(is_local_endpoint("http://0.0.0.0:1234/v1"));

        // Reject external endpoints to enforce LowCon privacy guardrails
        assert!(!is_local_endpoint("https://api.openai.com/v1"));
        assert!(!is_local_endpoint("http://192.168.1.100:1234/v1"));
        assert!(!is_local_endpoint("http://cloud-llm.example.com/v1"));
    }

    #[test]
    fn test_backend_creation_enforces_privacy() {
        assert!(LmStudioBackend::with_endpoint("http://127.0.0.1:1234/v1").is_ok());
        assert!(LmStudioBackend::with_endpoint("http://localhost:11434/v1").is_ok());

        let remote_err = LmStudioBackend::with_endpoint("https://remote-llm.org/v1");
        assert!(matches!(remote_err, Err(InferenceError::BackendError(_))));
    }

    #[test]
    fn test_parse_sse_line() {
        // Keep-alive or empty lines
        assert_eq!(parse_sse_line("").unwrap(), None);
        assert_eq!(parse_sse_line(": ping").unwrap(), None);

        // Standard token delta
        let token_line = r#"data: {"id":"chat-1","choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}"#;
        let parsed = parse_sse_line(token_line).unwrap();
        assert_eq!(parsed, Some((Some("Hello ".to_string()), None)));

        // Finish reason length
        let finish_len = r#"data: {"id":"chat-1","choices":[{"delta":{},"finish_reason":"length"}]}"#;
        let parsed_len = parse_sse_line(finish_len).unwrap();
        assert_eq!(parsed_len, Some((None, Some(StopReason::MaxTokens))));

        // [DONE] token
        let done_line = "data: [DONE]";
        let parsed_done = parse_sse_line(done_line).unwrap();
        assert_eq!(parsed_done, Some((None, Some(StopReason::Done))));
    }

    #[test]
    fn test_lm_studio_lifecycle() {
        let mut backend = LmStudioBackend::new();
        assert!(!backend.is_loaded());

        let profile = ModelProfile::new("qwen2.5-7b-instruct", PathBuf::from("local_server"), 8192);
        let meta = backend.load_model(&profile).unwrap();
        assert!(backend.is_loaded());
        assert_eq!(meta.name, "qwen2.5-7b-instruct");
        assert_eq!(meta.context_length, 8192);

        // Token count
        let count = backend.token_count("Hello local server!").unwrap();
        assert!(count > 0);

        // Unload
        backend.unload_model().unwrap();
        assert!(!backend.is_loaded());
    }
}
