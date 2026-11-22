pub mod config;
pub mod inference;
pub mod privacy;
pub mod storage;

pub use config::{AppSettings, BudgetPartition, ModelProfile};
pub use inference::{
    GenerationConfig, GenerationEvent, InferenceBackend, InferenceError, InferenceWorkerHandle,
    MockInferenceBackend, ModelMetadata, NativeInferenceBackend, StopReason, WorkerStatus,
};
pub use privacy::{DiagnosticLevel, DiagnosticLogger, OfflineStatus, StorageLocationPolicy};
pub use storage::{Database, MemoryNoteRecord, MessageRecord, SessionRecord, Vault, VaultManager};
