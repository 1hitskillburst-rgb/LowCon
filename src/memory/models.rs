use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use crate::storage::MemoryNoteRecord;

/// Classification of stored memory notes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NoteType {
    /// Manually created user note.
    Manual,
    /// Model-extracted or user-approved summary linked to conversation messages.
    ExtractedSummary,
    /// Explicitly pinned fact, constraint, or invariant.
    PinnedFact,
    /// Imported external context document excerpt.
    ImportedContext,
}

impl NoteType {
    pub fn as_str(&self) -> &'static str {
        match self {
            NoteType::Manual => "manual",
            NoteType::ExtractedSummary => "extracted_summary",
            NoteType::PinnedFact => "pinned_fact",
            NoteType::ImportedContext => "imported_context",
        }
    }
}

/// Rich domain model for memory notes with source message linkage and review state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryNote {
    pub id: String,
    pub session_id: Option<String>,
    pub title: String,
    pub content: String,
    pub source_message_ids: Vec<String>,
    pub source_reference: Option<String>,
    pub is_pinned: bool,
    pub is_disabled: bool,
    pub note_type: NoteType,
    pub user_approved: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl MemoryNote {
    /// Creates a new manual note.
    pub fn new_manual(
        title: impl Into<String>,
        content: impl Into<String>,
        session_id: Option<String>,
        is_pinned: bool,
    ) -> Self {
        let now = current_unix_timestamp();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            session_id,
            title: title.into(),
            content: content.into(),
            source_message_ids: Vec::new(),
            source_reference: None,
            is_pinned,
            is_disabled: false,
            note_type: if is_pinned { NoteType::PinnedFact } else { NoteType::Manual },
            user_approved: true,
            created_at: now,
            updated_at: now,
        }
    }

    /// Creates a new extracted summary linked to source message IDs.
    /// Event-driven summaries require user approval before becoming active in prompt context.
    pub fn new_extracted_summary(
        title: impl Into<String>,
        content: impl Into<String>,
        session_id: Option<String>,
        source_message_ids: Vec<String>,
        user_approved: bool,
    ) -> Self {
        let now = current_unix_timestamp();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            session_id,
            title: title.into(),
            content: content.into(),
            source_message_ids,
            source_reference: None,
            is_pinned: false,
            is_disabled: false,
            note_type: NoteType::ExtractedSummary,
            user_approved,
            created_at: now,
            updated_at: now,
        }
    }

    /// Creates a pinned rule or invariant note.
    pub fn new_pinned_rule(
        title: impl Into<String>,
        content: impl Into<String>,
        session_id: Option<String>,
    ) -> Self {
        Self::new_manual(title, content, session_id, true)
    }

    pub fn is_active(&self) -> bool {
        !self.is_disabled
    }

    pub fn is_summary(&self) -> bool {
        matches!(self.note_type, NoteType::ExtractedSummary)
    }

    /// A note can only be included in prompt context if it is not disabled and,
    /// if it is an extracted summary, it has been explicitly approved by the user.
    pub fn can_include_in_prompt(&self) -> bool {
        !self.is_disabled && (!self.is_summary() || self.user_approved)
    }
}

impl From<MemoryNoteRecord> for MemoryNote {
    fn from(rec: MemoryNoteRecord) -> Self {
        let source_ids = match rec.source_message_ids {
            Some(ref json) if !json.trim().is_empty() => {
                serde_json::from_str::<Vec<String>>(json).unwrap_or_else(|_| {
                    if let Some(ref single) = rec.source_message_id {
                        vec![single.clone()]
                    } else {
                        Vec::new()
                    }
                })
            }
            _ => {
                if let Some(ref single) = rec.source_message_id {
                    vec![single.clone()]
                } else {
                    Vec::new()
                }
            }
        };

        let note_type = if rec.is_summary {
            NoteType::ExtractedSummary
        } else if rec.is_pinned {
            NoteType::PinnedFact
        } else {
            NoteType::Manual
        };

        Self {
            id: rec.id,
            session_id: rec.session_id,
            title: rec.title.unwrap_or_default(),
            content: rec.content,
            source_message_ids: source_ids,
            source_reference: None,
            is_pinned: rec.is_pinned,
            is_disabled: rec.is_disabled,
            note_type,
            user_approved: rec.user_approved,
            created_at: rec.created_at,
            updated_at: rec.updated_at,
        }
    }
}

impl From<MemoryNote> for MemoryNoteRecord {
    fn from(note: MemoryNote) -> Self {
        let is_summary = note.is_summary();
        let source_json = if note.source_message_ids.is_empty() {
            None
        } else {
            serde_json::to_string(&note.source_message_ids).ok()
        };

        MemoryNoteRecord {
            id: note.id,
            session_id: note.session_id,
            title: if note.title.is_empty() { None } else { Some(note.title) },
            content: note.content,
            source_message_id: note.source_message_ids.first().cloned(),
            source_message_ids: source_json,
            is_pinned: note.is_pinned,
            is_summary,
            is_disabled: note.is_disabled,
            user_approved: note.user_approved,
            created_at: note.created_at,
            updated_at: note.updated_at,
        }
    }
}

/// A retrieved note scored by composite relevance metrics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoredMemoryNote {
    pub note: MemoryNote,
    pub final_score: f64,
    pub keyword_score: f64,
    pub session_score: f64,
    pub pin_score: f64,
    pub recency_score: f64,
    pub session_match: bool,
    pub is_pinned: bool,
    pub rank: usize,
}

/// Result of full-text message search across stored conversation history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageSearchResult {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub token_count: Option<usize>,
    pub created_at: i64,
    pub is_pinned: bool,
    pub rank: usize,
}

/// Parameters controlling memory retrieval and ranking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalOptions {
    pub query: Option<String>,
    pub session_id: Option<String>,
    pub limit: usize,
    pub include_disabled: bool,
    pub require_approved: bool,
    pub pinned_only: bool,
    pub summaries_only: bool,
    pub weights: ScoringWeights,
}

impl Default for RetrievalOptions {
    fn default() -> Self {
        Self {
            query: None,
            session_id: None,
            limit: 10,
            include_disabled: false,
            require_approved: true,
            pinned_only: false,
            summaries_only: false,
            weights: ScoringWeights::default(),
        }
    }
}

impl RetrievalOptions {
    pub fn for_prompt(session_id: Option<&str>, query: Option<&str>, limit: usize) -> Self {
        Self {
            query: query.map(|q| q.to_string()),
            session_id: session_id.map(|s| s.to_string()),
            limit,
            include_disabled: false,
            require_approved: true,
            pinned_only: false,
            summaries_only: false,
            weights: ScoringWeights::default(),
        }
    }
}

/// Tunable weights for composite ranking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoringWeights {
    /// Multiplier for BM25 keyword relevance from FTS5.
    pub keyword_weight: f64,
    /// Multiplier for session matching (same session vs global vs other).
    pub session_weight: f64,
    /// Multiplier for explicitly pinned items.
    pub pinned_weight: f64,
    /// Multiplier for recency decay.
    pub recency_weight: f64,
    /// Half-life in seconds for exponential recency decay (default 7 days).
    pub recency_half_life_secs: f64,
}

impl Default for ScoringWeights {
    fn default() -> Self {
        Self {
            keyword_weight: 1.0,
            session_weight: 0.5,
            pinned_weight: 2.0,
            recency_weight: 0.3,
            recency_half_life_secs: 7.0 * 86400.0,
        }
    }
}

pub(crate) fn current_unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
