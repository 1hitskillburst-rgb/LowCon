use serde::{Deserialize, Serialize};
use crate::context::template::TurnRole;

/// Minimal core system instructions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoreInstruction {
    pub text: String,
}

impl Default for CoreInstruction {
    fn default() -> Self {
        Self {
            text: "You are LowCon, a private, deterministic local assistant.\nFollow strict constraints and provide direct, accurate answers.".to_string(),
        }
    }
}

/// The current user request. This is MANDATORY and NEVER silently truncated.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CurrentUserMessage {
    pub content: String,
    pub metadata: Option<String>,
}

impl CurrentUserMessage {
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            metadata: None,
        }
    }

    pub fn with_metadata(content: impl Into<String>, metadata: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            metadata: Some(metadata.into()),
        }
    }
}

/// Explicitly pinned instructions or facts for the session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PinnedFact {
    pub id: String,
    pub title: String,
    pub content: String,
    pub source_reference: Option<String>,
}

/// Compact active task state: goals, constraints, decisions, unresolved questions.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct TaskState {
    pub goals: Vec<String>,
    pub constraints: Vec<String>,
    pub decisions: Vec<String>,
    pub unresolved_questions: Vec<String>,
}

impl TaskState {
    pub fn is_empty(&self) -> bool {
        self.goals.is_empty()
            && self.constraints.is_empty()
            && self.decisions.is_empty()
            && self.unresolved_questions.is_empty()
    }

    /// Formats task state in a compact, low-token representation.
    pub fn format_compact(&self) -> String {
        if self.is_empty() {
            return String::new();
        }

        let mut lines = Vec::new();
        lines.push("[Active Task State]".to_string());
        for g in &self.goals {
            lines.push(format!("- Goal: {}", g));
        }
        for c in &self.constraints {
            lines.push(format!("- Constraint: {}", c));
        }
        for d in &self.decisions {
            lines.push(format!("- Decision: {}", d));
        }
        for u in &self.unresolved_questions {
            lines.push(format!("- Open: {}", u));
        }
        lines.join("\n")
    }
}

/// Retrieved memory note from local SQLite/FTS5 storage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryExcerpt {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub source_message_id: Option<String>,
    pub relevance_score: f32,
    pub is_pinned: bool,
}

impl MemoryExcerpt {
    pub fn format_for_prompt(&self) -> String {
        let mut text = format!("[Memory: {}]\n{}", self.title, self.excerpt.trim());
        if let Some(src) = &self.source_message_id {
            text.push_str(&format!(" (source: #{})", src));
        }
        text
    }
}

/// A conversation turn from transcript history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationTurn {
    pub id: String,
    pub role: TurnRole,
    pub content: String,
    pub is_pinned: bool,
    pub timestamp: i64,
    pub metadata: Option<String>,
}

impl ConversationTurn {
    pub fn user(id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            role: TurnRole::User,
            content: content.into(),
            is_pinned: false,
            timestamp: 0,
            metadata: None,
        }
    }

    pub fn assistant(id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            role: TurnRole::Assistant,
            content: content.into(),
            is_pinned: false,
            timestamp: 0,
            metadata: None,
        }
    }
}

/// Optional summary note covering older conversation turns.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SummaryExcerpt {
    pub id: String,
    pub summary_text: String,
    pub compact_version: Option<String>,
    pub source_turn_range: String,
    pub is_pinned: bool,
}

impl SummaryExcerpt {
    pub fn format_for_prompt(&self, use_compact: bool) -> String {
        let body = if use_compact {
            self.compact_version
                .as_deref()
                .unwrap_or(self.summary_text.as_str())
        } else {
            self.summary_text.as_str()
        };
        format!("[Summary (Turns {})]\n{}", self.source_turn_range, body.trim())
    }
}

/// Container with all candidates presented for prompt assembly.
#[derive(Debug, Clone, Default)]
pub struct AssemblyCandidates {
    pub core_instruction: Option<CoreInstruction>,
    pub current_user_message: Option<CurrentUserMessage>,
    pub pinned_facts: Vec<PinnedFact>,
    pub task_state: Option<TaskState>,
    pub retrieved_memories: Vec<MemoryExcerpt>,
    pub conversation_turns: Vec<ConversationTurn>,
    pub summaries: Vec<SummaryExcerpt>,
}
