use thiserror::Error;
use crate::storage::StorageError;

#[derive(Debug, Error)]
pub enum MemoryError {
    #[error("Storage error: {0}")]
    Storage(#[from] StorageError),

    #[error("SQLite database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Note not found: {0}")]
    NotFound(String),

    #[error("Invalid memory operation: {0}")]
    InvalidOperation(String),
}
