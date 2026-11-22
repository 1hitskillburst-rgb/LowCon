use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChatTemplateType {
    ChatML,
    Llama3,
    Llama2,
    Mistral,
    Gemma,
    Raw,
    Custom,
}

impl Default for ChatTemplateType {
    fn default() -> Self {
        Self::ChatML
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    pub file_path: PathBuf,
    pub context_capacity: usize,
    pub context_override: Option<usize>,
    pub chat_template: ChatTemplateType,
    pub custom_template: Option<String>,
    pub temperature: f32,
    pub top_p: f32,
    pub threads: usize,
    pub gpu_layers: usize,
    pub architecture: Option<String>,
    pub quantization: Option<String>,
    pub created_at: i64,
}

impl ModelProfile {
    pub fn new(name: impl Into<String>, file_path: PathBuf, context_capacity: usize) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        Self {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            file_path,
            context_capacity,
            context_override: None,
            chat_template: ChatTemplateType::default(),
            custom_template: None,
            temperature: 0.7,
            top_p: 0.9,
            threads: 4,
            gpu_layers: 0,
            architecture: None,
            quantization: None,
            created_at: now,
        }
    }

    /// Effective context limit respecting user override if present.
    pub fn effective_context_limit(&self) -> usize {
        self.context_override.unwrap_or(self.context_capacity)
    }
}
