use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::sync::Arc;

use crate::config::ModelProfile;
use super::error::InferenceError;
use super::types::{GenerationConfig, GenerationEvent, ModelMetadata};

/// Core abstraction for local in-process inference backends.
/// Supports both real native adapters (e.g. llama.cpp) and deterministic offline mock backends.
pub trait InferenceBackend: Send + Sync {
    /// Load a local model specified by the ModelProfile.
    /// Fails if another model is already loaded without unloading first.
    fn load_model(&mut self, profile: &ModelProfile) -> Result<ModelMetadata, InferenceError>;

    /// Unload the currently loaded model, freeing backend resources and memory.
    fn unload_model(&mut self) -> Result<(), InferenceError>;

    /// Count or estimate the number of tokens in the given text using the model's tokenizer.
    fn token_count(&self, text: &str) -> Result<usize, InferenceError>;

    /// Stream generation output through the mpsc sender.
    /// Checked on every token iteration against `cancel_token`.
    fn stream_generate(
        &mut self,
        prompt: &str,
        config: &GenerationConfig,
        token_tx: Sender<GenerationEvent>,
        cancel_token: Arc<AtomicBool>,
    ) -> Result<(), InferenceError>;

    /// Returns metadata of the currently loaded model, if any.
    fn get_metadata(&self) -> Option<&ModelMetadata>;

    /// Returns whether a model is currently loaded in memory.
    fn is_loaded(&self) -> bool {
        self.get_metadata().is_some()
    }
}
