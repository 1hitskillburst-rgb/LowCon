pub mod engine;
pub mod error;
pub mod fts;
pub mod models;
pub mod scoring;

pub use engine::MemoryEngine;
pub use error::MemoryError;
pub use fts::{sanitize_fts5_and_query, sanitize_fts5_query};
pub use models::{
    MemoryNote, MessageSearchResult, NoteType, RetrievalOptions, ScoredMemoryNote, ScoringWeights,
};
pub use scoring::{calculate_recency_score, calculate_score, rank_and_sort_notes};

#[cfg(test)]
mod tests;
