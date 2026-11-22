use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use crate::config::ModelProfile;
use super::backend::InferenceBackend;
use super::error::InferenceError;
use super::gguf::parse_gguf_file;
use super::types::{GenerationConfig, GenerationEvent, ModelMetadata, StopReason};

/// Deterministic offline mock backend for tests and environments without local GGUF weights.
pub struct MockInferenceBackend {
    loaded_metadata: Option<ModelMetadata>,
    token_delay: Duration,
    custom_responses: HashMap<String, String>,
}

impl Default for MockInferenceBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl MockInferenceBackend {
    pub fn new() -> Self {
        Self {
            loaded_metadata: None,
            token_delay: Duration::ZERO,
            custom_responses: HashMap::new(),
        }
    }

    /// Set simulated delay between tokens for testing streaming behavior.
    pub fn with_delay(mut self, delay: Duration) -> Self {
        self.token_delay = delay;
        self
    }

    /// Configure explicit response for prompts containing a specific keyword.
    pub fn with_response(mut self, keyword: impl Into<String>, response: impl Into<String>) -> Self {
        self.custom_responses.insert(keyword.into(), response.into());
        self
    }

    /// Set delay dynamically.
    pub fn set_delay(&mut self, delay: Duration) {
        self.token_delay = delay;
    }

    /// Add a custom response dynamically.
    pub fn add_response(&mut self, keyword: impl Into<String>, response: impl Into<String>) {
        self.custom_responses.insert(keyword.into(), response.into());
    }

    /// Deterministic response generator based on the prompt content.
    fn generate_deterministic_text(&self, prompt: &str) -> String {
        // Check for custom configured responses first
        for (keyword, response) in &self.custom_responses {
            if prompt.contains(keyword) {
                return response.clone();
            }
        }

        // Standard deterministic response
        if prompt.to_lowercase().contains("why does my smaller model") {
            "The model isn't really remembering the whole conversation. It only sees the tokens included in its current prompt. As the chat grows, older details either get pushed out or compete with the current request.\n\nThe better fix is to separate history from active context. Keep the full transcript on disk, then build a small, relevant prompt for every turn.\n\nFor this request, the harness selected your active constraint, two source-linked memory notes, and the newest turns. Older messages remain saved locally but aren't spending tokens right now.".to_string()
        } else if prompt.to_lowercase().contains("rust") {
            "In Rust, deterministic memory safety without a garbage collector is achieved through ownership, borrowing, and lifetimes. For offline local LLMs, safe FFI wrappers ensure memory is released cleanly when models are unloaded.".to_string()
        } else if prompt.to_lowercase().contains("offline") || prompt.to_lowercase().contains("privacy") {
            "LowCon operates strictly offline with zero remote network requests, background daemons, or telemetry. All conversations, memory, and model profiles remain exclusively on your local encrypted storage.".to_string()
        } else {
            "Deterministic mock output: Generation completed successfully using the local LowCon offline harness. Context invariants maintained.".to_string()
        }
    }
}

impl InferenceBackend for MockInferenceBackend {
    fn load_model(&mut self, profile: &ModelProfile) -> Result<ModelMetadata, InferenceError> {
        if let Some(loaded) = &self.loaded_metadata {
            return Err(InferenceError::ModelAlreadyLoaded(loaded.name.clone()));
        }

        // If file exists and is a .gguf file, parse its header
        let metadata = if profile.file_path.exists()
            && profile
                .file_path
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("gguf"))
                .unwrap_or(false)
        {
            parse_gguf_file(&profile.file_path)?
        } else {
            // Otherwise construct metadata from profile
            ModelMetadata {
                name: profile.name.clone(),
                architecture: profile.architecture.clone().unwrap_or_else(|| "llama".to_string()),
                quantization: profile.quantization.clone().unwrap_or_else(|| "Q4_K_M".to_string()),
                context_length: profile.effective_context_limit(),
                file_size_bytes: 4_294_967_296, // 4 GB placeholder
                tensor_count: 290,
                embedding_length: Some(4096),
                block_count: Some(32),
                chat_template: profile.custom_template.clone(),
                description: Some("Mock local model profile".to_string()),
                extra_kv: HashMap::new(),
            }
        };

        self.loaded_metadata = Some(metadata.clone());
        Ok(metadata)
    }

    fn unload_model(&mut self) -> Result<(), InferenceError> {
        if self.loaded_metadata.is_none() {
            return Err(InferenceError::ModelNotLoaded);
        }
        self.loaded_metadata = None;
        Ok(())
    }

    fn token_count(&self, text: &str) -> Result<usize, InferenceError> {
        if text.is_empty() {
            return Ok(0);
        }
        // Conservative deterministic token counter:
        // ~1.3 tokens per word + punctuation
        let words = text.split_whitespace().count();
        let punctuation = text.chars().filter(|c| c.is_ascii_punctuation()).count();
        // Every 3 punctuation characters is approx 1 token
        let punct_tokens = (punctuation + 2) / 3;
        let count = ((words * 4) + 2) / 3 + punct_tokens;
        Ok(count.max(1))
    }

    fn stream_generate(
        &mut self,
        prompt: &str,
        config: &GenerationConfig,
        token_tx: Sender<GenerationEvent>,
        cancel_token: Arc<AtomicBool>,
    ) -> Result<(), InferenceError> {
        let metadata = self.loaded_metadata.as_ref().ok_or(InferenceError::ModelNotLoaded)?;

        // Validate context bounds
        let prompt_tokens = self.token_count(prompt)?;
        if prompt_tokens > metadata.context_length {
            return Err(InferenceError::ContextCapacityExceeded {
                requested: prompt_tokens,
                capacity: metadata.context_length,
            });
        }

        let full_text = self.generate_deterministic_text(prompt);

        // Split text into word-level tokens (preserving whitespace)
        let mut tokens: Vec<String> = Vec::new();
        let mut current_token = String::new();

        for ch in full_text.chars() {
            current_token.push(ch);
            if ch.is_whitespace() || ch.is_ascii_punctuation() {
                tokens.push(current_token.clone());
                current_token.clear();
            }
        }
        if !current_token.is_empty() {
            tokens.push(current_token);
        }

        let mut emitted_tokens = 0;
        let mut stop_reason = StopReason::Done;

        for token in tokens {
            // Check cancellation token before processing
            if cancel_token.load(Ordering::Relaxed) {
                let _ = token_tx.send(GenerationEvent::Cancelled);
                return Err(InferenceError::Cancelled);
            }

            // Simulate latency if configured
            if self.token_delay > Duration::ZERO {
                std::thread::sleep(self.token_delay);
            }

            // Check cancellation again after potential delay
            if cancel_token.load(Ordering::Relaxed) {
                let _ = token_tx.send(GenerationEvent::Cancelled);
                return Err(InferenceError::Cancelled);
            }

            // Check stop sequences
            let mut hit_stop_seq = false;
            for stop in &config.stop_sequences {
                if token.contains(stop) {
                    stop_reason = StopReason::StopSequence(stop.clone());
                    hit_stop_seq = true;
                    break;
                }
            }

            if hit_stop_seq {
                break;
            }

            emitted_tokens += 1;
            if token_tx.send(GenerationEvent::Token(token)).is_err() {
                // UI receiver was dropped (e.g. closed window or turn cancelled)
                return Err(InferenceError::WorkerChannelClosed);
            }

            if emitted_tokens >= config.max_tokens {
                stop_reason = StopReason::MaxTokens;
                break;
            }
        }

        let _ = token_tx.send(GenerationEvent::Complete {
            total_tokens: emitted_tokens,
            stop_reason,
        });

        Ok(())
    }

    fn get_metadata(&self) -> Option<&ModelMetadata> {
        self.loaded_metadata.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::mpsc::channel;

    #[test]
    fn test_mock_backend_lifecycle() {
        let mut backend = MockInferenceBackend::new();
        assert!(!backend.is_loaded());
        assert_eq!(backend.get_metadata(), None);

        // Load model
        let profile = ModelProfile::new("Test Model", PathBuf::from("mock_model.gguf"), 4096);
        let meta = backend.load_model(&profile).unwrap();
        assert!(backend.is_loaded());
        assert_eq!(meta.name, "Test Model");
        assert_eq!(meta.context_length, 4096);

        // Loading again without unload must fail
        assert!(matches!(
            backend.load_model(&profile),
            Err(InferenceError::ModelAlreadyLoaded(_))
        ));

        // Token count
        let count = backend.token_count("Hello world! How are you doing today?").unwrap();
        assert!(count > 0);

        // Stream generate
        let (tx, rx) = channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let config = GenerationConfig::default();

        backend
            .stream_generate("Tell me about rust programming", &config, tx, cancel)
            .unwrap();

        let events: Vec<_> = rx.into_iter().collect();
        assert!(!events.is_empty());
        assert!(matches!(events.last(), Some(GenerationEvent::Complete { .. })));

        // Unload model
        backend.unload_model().unwrap();
        assert!(!backend.is_loaded());
        assert_eq!(backend.get_metadata(), None);

        // Unload when already unloaded fails
        assert!(matches!(backend.unload_model(), Err(InferenceError::ModelNotLoaded)));
    }

    #[test]
    fn test_mock_backend_cancellation() {
        let mut backend = MockInferenceBackend::new().with_delay(Duration::from_millis(5));
        let profile = ModelProfile::new("Cancel Test", PathBuf::from("test.gguf"), 4096);
        backend.load_model(&profile).unwrap();

        let (tx, rx) = channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_clone = cancel.clone();

        // Spawn a thread to cancel shortly after start
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(15));
            cancel_clone.store(true, Ordering::SeqCst);
        });

        let config = GenerationConfig {
            max_tokens: 1000,
            ..Default::default()
        };

        let result = backend.stream_generate("Why does my smaller model fail?", &config, tx, cancel);
        assert_eq!(result, Err(InferenceError::Cancelled));

        let events: Vec<_> = rx.into_iter().collect();
        assert!(events.iter().any(|e| matches!(e, GenerationEvent::Cancelled)));
    }
}
