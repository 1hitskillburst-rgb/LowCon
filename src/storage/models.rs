use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub pinned_facts: Option<String>,
    pub task_state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageRecord {
    pub id: String,
    pub session_id: String,
    pub role: String, // "user", "assistant", "system"
    pub content: String,
    pub token_count: Option<usize>,
    pub created_at: i64,
    pub is_pinned: bool,
    pub metadata: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryNoteRecord {
    pub id: String,
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub content: String,
    pub source_message_id: Option<String>,
    pub source_message_ids: Option<String>,
    pub is_pinned: bool,
    pub is_summary: bool,
    pub is_disabled: bool,
    pub user_approved: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelProfileRecord {
    pub id: String,
    pub name: String,
    pub file_path: String,
    pub context_capacity: usize,
    pub context_override: Option<usize>,
    pub chat_template: String,
    pub settings_json: String,
    pub created_at: i64,
}
