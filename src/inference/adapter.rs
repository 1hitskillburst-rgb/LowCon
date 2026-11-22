use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::sync::Arc;

use crate::config::ModelProfile;
use super::backend::InferenceBackend;
use super::error::InferenceError;
use super::gguf::parse_gguf_file;
use super::mock::MockInferenceBackend;
use super::types::{GenerationConfig, GenerationEvent, ModelMetadata};

/// Native inference adapter conforming to the `InferenceBackend` trait.
/// Enforces local-only privacy boundaries, validates GGUF files, and delegates
/// to either an in-process native engine or the deterministic offline fallback.
pub struct NativeInferenceBackend {
    inner: Box<dyn InferenceBackend>,
}

impl Default for NativeInferenceBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeInferenceBackend {
    /// Create a new adapter using the default offline backend.
    pub fn new() -> Self {
        Self {
            inner: Box::new(MockInferenceBackend::new()),
        }
    }

    /// Create an adapter wrapping an explicit custom backend implementation.
    pub fn with_backend(backend: Box<dyn InferenceBackend>) -> Self {
        Self { inner: backend }
    }
}

impl InferenceBackend for NativeInferenceBackend {
    fn load_model(&mut self, profile: &ModelProfile) -> Result<ModelMetadata, InferenceError> {
        // Enforce offline privacy invariant: no remote network URLs
        let path_str = profile.file_path.to_string_lossy();
        if path_str.starts_with("http://")
            || path_str.starts_with("https://")
            || path_str.starts_with("ftp://")
        {
            return Err(InferenceError::BackendError(
                "Remote model URLs are strictly prohibited by LowCon privacy guardrails.".to_string(),
            ));
        }

        // If the file exists and is a .gguf, parse and validate the GGUF header first
        if profile.file_path.exists()
            && profile
                .file_path
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("gguf"))
                .unwrap_or(false)
        {
            let parsed_meta = parse_gguf_file(&profile.file_path)?;
            // If the user hasn't overridden context and profile capacity is 0, we can validate
            if profile.context_capacity > 0 && profile.context_capacity > parsed_meta.context_length * 4 {
                return Err(InferenceError::BackendError(format!(
                    "Configured context limit ({}) dangerously exceeds model context capacity ({}).",
                    profile.context_capacity, parsed_meta.context_length
                )));
            }
        }

        self.inner.load_model(profile)
    }

    fn unload_model(&mut self) -> Result<(), InferenceError> {
        self.inner.unload_model()
    }

    fn token_count(&self, text: &str) -> Result<usize, InferenceError> {
        self.inner.token_count(text)
    }

    fn stream_generate(
        &mut self,
        prompt: &str,
        config: &GenerationConfig,
        token_tx: Sender<GenerationEvent>,
        cancel_token: Arc<AtomicBool>,
    ) -> Result<(), InferenceError> {
        self.inner.stream_generate(prompt, config, token_tx, cancel_token)
    }

    fn get_metadata(&self) -> Option<&ModelMetadata> {
        self.inner.get_metadata()
    }

    fn is_loaded(&self) -> bool {
        self.inner.is_loaded()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_adapter_rejects_remote_url() {
        let mut adapter = NativeInferenceBackend::new();
        let profile = ModelProfile::new(
            "Cloud Model",
            PathBuf::from("https://example.com/model.gguf"),
            4096,
        );
        let result = adapter.load_model(&profile);
        assert!(matches!(result, Err(InferenceError::BackendError(_))));
    }

    #[test]
    fn test_adapter_delegation() {
        let mut adapter = NativeInferenceBackend::new();
        let profile = ModelProfile::new("Local Mock", PathBuf::from("test.gguf"), 4096);
        let meta = adapter.load_model(&profile).unwrap();
        assert_eq!(meta.name, "Local Mock");
        assert!(adapter.is_loaded());

        let count = adapter.token_count("Testing token count").unwrap();
        assert!(count > 0);

        adapter.unload_model().unwrap();
        assert!(!adapter.is_loaded());
    }
}
