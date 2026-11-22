pub mod app;
pub mod config;
pub mod context;
pub mod inference;
pub mod memory;
pub mod privacy;
pub mod storage;
pub mod ui;

pub use config::{AppSettings, BudgetPartition, ModelProfile};
pub use context::{
    AssemblyCandidates, BudgetConfig, ChatTemplateRenderer, ConservativeEstimator,
    ContextAssemblyEngine, ContextBudgetCalculator, ContextError, ConversationTurn,
    CoreInstruction, CurrentUserMessage, ExactMockTokenizer, ExcludedCandidate,
    IncludedItem, MemoryExcerpt, PinnedFact, PromptInspection, SectionTokenBreakdown,
    SummaryExcerpt, TaskState, Tokenizer, TurnRole,
};
pub use inference::{
    GenerationConfig, GenerationEvent, InferenceBackend, InferenceError, InferenceWorkerHandle,
    MockInferenceBackend, ModelMetadata, NativeInferenceBackend, StopReason, WorkerStatus,
};
pub use memory::{
    calculate_recency_score, calculate_score, rank_and_sort_notes, sanitize_fts5_and_query,
    sanitize_fts5_query, MemoryEngine, MemoryError, MemoryNote, MessageSearchResult, NoteType,
    RetrievalOptions, ScoredMemoryNote, ScoringWeights,
};
pub use privacy::{DiagnosticLevel, DiagnosticLogger, OfflineStatus, StorageLocationPolicy};
pub use storage::{Database, MemoryNoteRecord, MessageRecord, SessionRecord, Vault, VaultManager};
