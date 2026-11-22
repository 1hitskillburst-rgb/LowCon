use egui::Color32;
use crate::ui::theme::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationTab {
    Chat,
    Models,
    Memory,
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    #[allow(dead_code)]
    pub id: String,
    pub role: MessageRole,
    pub author_name: String,
    pub time_str: String,
    pub model_info: Option<String>,
    pub content: String,
    pub aside: Option<String>,
    pub sources: Vec<String>,
    pub turn_budget: Option<TurnContextBudget>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContextSegmentKey {
    Core,
    Task,
    Mem,
    Recent,
    Tpl,
    Free,
    Out,
    Safe,
}

#[derive(Debug, Clone)]
pub struct ContextSegment {
    pub key: ContextSegmentKey,
    pub name: String,
    pub description: String,
    pub tokens: usize,
    pub color: Color32,
    pub is_held: bool,
    pub is_free: bool,
}

#[derive(Debug, Clone)]
pub struct TurnContextBudget {
    pub total_limit: usize,
    pub segments: Vec<ContextSegment>,
}

impl TurnContextBudget {
    pub fn new_default_8k() -> Self {
        Self {
            total_limit: 8192,
            segments: vec![
                ContextSegment {
                    key: ContextSegmentKey::Core,
                    name: "Core instructions".into(),
                    description: "Always included, compact".into(),
                    tokens: 416,
                    color: COLOR_SEG_CORE,
                    is_held: false,
                    is_free: false,
                },
                ContextSegment {
                    key: ContextSegmentKey::Task,
                    name: "Active task state".into(),
                    description: "Pinned constraints, current goal".into(),
                    tokens: 1180,
                    color: COLOR_SEG_TASK,
                    is_held: false,
                    is_free: false,
                },
                ContextSegment {
                    key: ContextSegmentKey::Mem,
                    name: "Retrieved memory".into(),
                    description: "2 exact, source-linked notes".into(),
                    tokens: 624,
                    color: COLOR_SEG_MEM,
                    is_held: false,
                    is_free: false,
                },
                ContextSegment {
                    key: ContextSegmentKey::Recent,
                    name: "Recent turns".into(),
                    description: "Newest relevant messages".into(),
                    tokens: 1240,
                    color: COLOR_SEG_RECENT,
                    is_held: false,
                    is_free: false,
                },
                ContextSegment {
                    key: ContextSegmentKey::Tpl,
                    name: "Chat template".into(),
                    description: "Model-specific formatting".into(),
                    tokens: 700,
                    color: COLOR_SEG_TPL,
                    is_held: false,
                    is_free: false,
                },
                ContextSegment {
                    key: ContextSegmentKey::Free,
                    name: "Free".into(),
                    description: "Room for more".into(),
                    tokens: 2496,
                    color: COLOR_SEG_FREE,
                    is_held: false,
                    is_free: true,
                },
                ContextSegment {
                    key: ContextSegmentKey::Out,
                    name: "Reply space".into(),
                    description: "Reserved for the answer".into(),
                    tokens: 1024,
                    color: COLOR_SEG_HOLD,
                    is_held: true,
                    is_free: false,
                },
                ContextSegment {
                    key: ContextSegmentKey::Safe,
                    name: "Safety margin".into(),
                    description: "Buffer against overflow".into(),
                    tokens: 512,
                    color: COLOR_SEG_HOLD,
                    is_held: true,
                    is_free: false,
                },
            ],
        }
    }

    pub fn packed_tokens(&self) -> usize {
        self.segments
            .iter()
            .filter(|s| !s.is_free && !s.is_held)
            .map(|s| s.tokens)
            .sum()
    }

    pub fn free_tokens(&self) -> usize {
        self.segments
            .iter()
            .find(|s| s.key == ContextSegmentKey::Free)
            .map(|s| s.tokens)
            .unwrap_or(0)
    }

    pub fn packed_percentage(&self) -> f32 {
        if self.total_limit == 0 {
            0.0
        } else {
            (self.packed_tokens() as f32 / self.total_limit as f32) * 100.0
        }
    }
}

#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone)]
pub struct MemoryNote {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub source_reference: String,
    pub is_pinned: bool,
    pub is_auto_extracted: bool,
    pub is_in_active_prompt: bool,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    pub file_path: String,
    pub architecture: String,
    pub quantization: String,
    pub context_limit: usize,
    pub context_override: Option<usize>,
    pub file_size_bytes: u64,
    pub is_loaded: bool,
    pub ram_footprint_mb: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct PromptInspectorState {
    pub is_open: bool,
    pub exact_prompt: String,
    pub sections: Vec<(String, usize)>,
    pub included_items: Vec<String>,
    pub excluded_candidates: Vec<(String, String)>,
    pub output_reserve: usize,
    pub safety_margin: usize,
    pub remaining_capacity: usize,
}

impl Default for PromptInspectorState {
    fn default() -> Self {
        Self {
            is_open: false,
            exact_prompt: "<|im_start|>system\nYou are LowCon, a private, deterministic local assistant.\nFollow strict token constraints.<|im_end|>\n<|im_start|>user\n[Rule: Keep original conversation history intact]\n[Memory: Prefer deterministic prompt packing over model-managed recall]\nWhy does my smaller model keep losing earlier constraints when a conversation gets long?<|im_end|>\n<|im_start|>assistant\n".into(),
            sections: vec![
                ("Core system instructions".into(), 416),
                ("Active task state".into(), 1180),
                ("Retrieved memory excerpts (2 items)".into(), 624),
                ("Recent conversation turns (2 turns)".into(), 1240),
                ("Chat template & formatting tags".into(), 700),
            ],
            included_items: vec![
                "Pinned Rule: Keep original conversation history intact (Session 04, msg 18)".into(),
                "Memory Note: Prefer deterministic prompt packing over model-managed recall (Note 07)".into(),
                "Recent Turn #1: User constraint question (1240 tokens)".into(),
            ],
            excluded_candidates: vec![
                ("Session 01 Turn 4".into(), "Oldest turn outside 4,160 packed budget window".into()),
                ("Note 12 (Rust Async I/O)".into(), "FTS5 relevance score 0.12 below retrieval cutoff".into()),
                ("Unpinned session summary".into(), "Trimmed during step 2 overflow pass to preserve recent turns".into()),
            ],
            output_reserve: 1024,
            safety_margin: 512,
            remaining_capacity: 2496,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AppSettings {
    pub output_reserve_pct: f32,
    pub safety_margin_pct: f32,
    pub context_limit_override: usize,
    pub memory_retrieval_enabled: bool,
    pub storage_path: String,
    pub is_vault_locked: bool,
    pub vault_passphrase: String,
    pub diagnostic_logs_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            output_reserve_pct: 20.0,
            safety_margin_pct: 5.0,
            context_limit_override: 8192,
            memory_retrieval_enabled: true,
            storage_path: "C:\\Users\\augpo\\AppData\\Roaming\\LowCon\\vault.db".into(),
            is_vault_locked: false,
            vault_passphrase: String::new(),
            diagnostic_logs_enabled: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_turn_context_budget_8k_invariants() {
        let budget = TurnContextBudget::new_default_8k();
        assert_eq!(budget.total_limit, 8192);

        // Core (416) + Task (1180) + Mem (624) + Recent (1240) + Tpl (700) = 4160
        assert_eq!(budget.packed_tokens(), 4160);
        assert_eq!(budget.free_tokens(), 2496);

        // Total allocated tokens
        let total_tokens: usize = budget.segments.iter().map(|s| s.tokens).sum();
        assert_eq!(total_tokens, 8192);

        // Percentage packed should be ~50.78% (rounded to ~51%)
        let pct = budget.packed_percentage();
        assert!((pct - 50.78).abs() < 0.1);
    }

    #[test]
    fn test_prompt_inspector_state_defaults() {
        let inspector = PromptInspectorState::default();
        assert!(!inspector.is_open);
        assert!(!inspector.exact_prompt.is_empty());
        assert_eq!(inspector.output_reserve, 1024);
        assert_eq!(inspector.safety_margin, 512);
        assert_eq!(inspector.remaining_capacity, 2496);
        assert_eq!(inspector.included_items.len(), 3);
        assert_eq!(inspector.excluded_candidates.len(), 3);
    }

    #[test]
    fn test_app_settings_defaults() {
        let settings = AppSettings::default();
        assert_eq!(settings.output_reserve_pct, 20.0);
        assert_eq!(settings.safety_margin_pct, 5.0);
        assert_eq!(settings.context_limit_override, 8192);
        assert!(settings.memory_retrieval_enabled);
        assert!(!settings.is_vault_locked);
        assert!(!settings.diagnostic_logs_enabled);
    }
}
