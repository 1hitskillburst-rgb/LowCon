use std::path::PathBuf;
use thiserror::Error;

#[derive(Error, Debug, Clone, PartialEq)]
pub enum InferenceError {
    #[error("No model is currently loaded in memory")]
    ModelNotLoaded,

    #[error("A model is already loaded: {0}. Unload it before loading another model.")]
    ModelAlreadyLoaded(String),

    #[error("Model file not found at path: {0}")]
    FileNotFound(PathBuf),

    #[error("Invalid GGUF format: {0}")]
    InvalidGgufFormat(String),

    #[error("Corrupt GGUF header or metadata: {0}")]
    CorruptHeader(String),

    #[error("Unsupported GGUF version: {0} (supported versions: 1, 2, 3)")]
    UnsupportedGgufVersion(u32),

    #[error("Context limit exceeded: requested {requested} tokens, model capacity is {capacity} tokens")]
    ContextCapacityExceeded {
        requested: usize,
        capacity: usize,
    },

    #[error("Generation failed: {0}")]
    GenerationFailed(String),

    #[error("Generation cancelled by user")]
    Cancelled,

    #[error("Worker thread communication channel closed unexpectedly")]
    WorkerChannelClosed,

    #[error("Inference background worker panicked")]
    WorkerThreadPanicked,

    #[error("Backend initialization error: {0}")]
    BackendError(String),

    #[error("I/O error during model operation: {0}")]
    IoError(String),
}

impl From<std::io::Error> for InferenceError {
    fn from(err: std::io::Error) -> Self {
        InferenceError::IoError(err.to_string())
    }
}
