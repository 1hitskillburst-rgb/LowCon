use serde::{Deserialize, Serialize};
use crate::config::BudgetPartition;

/// Category of an item candidate in the context assembly pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CandidateKind {
    CoreInstruction,
    CurrentUserMessage,
    PinnedFact,
    TaskState,
    RetrievedMemory,
    ConversationTurn,
    Summary,
    Metadata,
    TemplateOverhead,
}

impl CandidateKind {
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::CoreInstruction => "Core System Instruction",
            Self::CurrentUserMessage => "Current User Message",
            Self::PinnedFact => "Pinned Fact / Rule",
            Self::TaskState => "Active Task State",
            Self::RetrievedMemory => "Retrieved Memory Note",
            Self::ConversationTurn => "Conversation Turn",
            Self::Summary => "Turn Summary",
            Self::Metadata => "Turn Metadata",
            Self::TemplateOverhead => "Chat Template Syntax",
        }
    }
}

/// Token accounting breakdown for an assembled prompt section.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SectionTokenBreakdown {
    pub name: String,
    pub tokens: usize,
    pub description: String,
}

/// Details of an item included in the final rendered prompt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IncludedItem {
    pub id: String,
    pub kind: CandidateKind,
    pub label: String,
    pub tokens: usize,
    pub source_ref: Option<String>,
}

/// Details of an item candidate excluded during priority assembly or overflow trimming.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExcludedCandidate {
    pub id: String,
    pub kind: CandidateKind,
    pub label: String,
    pub estimated_tokens: usize,
    pub reason: String,
}

/// Full inspectable output from the Budget-First Context Assembly Engine.
/// Contains everything needed to display the exact prompt, per-section accounting,
/// included items, and excluded candidates with explainable reasons.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PromptInspection {
    /// Exact rendered string sent to the inference backend.
    pub exact_rendered_prompt: String,
    /// Total tokens in the rendered prompt.
    pub total_tokens: usize,
    /// Whether the token count was verified with exact model tokenizer.
    pub is_exact_count: bool,
    /// Name of the tokenizer used.
    pub tokenizer_name: String,
    /// Budget partition calculated for this generation.
    pub budget_partition: BudgetPartition,
    /// Free remaining tokens before hitting prompt budget ceiling.
    pub remaining_capacity: usize,
    /// Per-section token breakdown.
    pub sections: Vec<SectionTokenBreakdown>,
    /// Items successfully packed into the prompt.
    pub included_items: Vec<IncludedItem>,
    /// Candidates excluded during trimming with explainable reasons.
    pub excluded_candidates: Vec<ExcludedCandidate>,
}

impl PromptInspection {
    /// Formatted section tuples (name, token_count) ready for UI display.
    pub fn ui_sections(&self) -> Vec<(String, usize)> {
        self.sections
            .iter()
            .map(|s| (s.name.clone(), s.tokens))
            .collect()
    }

    /// Formatted included item strings for UI display.
    pub fn ui_included_items(&self) -> Vec<String> {
        self.included_items
            .iter()
            .map(|item| {
                if let Some(src) = &item.source_ref {
                    format!("{}: {} ({} tokens, source: #{})", item.kind.display_name(), item.label, item.tokens, src)
                } else {
                    format!("{}: {} ({} tokens)", item.kind.display_name(), item.label, item.tokens)
                }
            })
            .collect()
    }

    /// Formatted excluded candidate pairs (label, reason) for UI display.
    pub fn ui_excluded_candidates(&self) -> Vec<(String, String)> {
        self.excluded_candidates
            .iter()
            .map(|item| (item.label.clone(), item.reason.clone()))
            .collect()
    }
}
